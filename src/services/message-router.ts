/**
 * Message router: turns an incoming Telegram text message into exactly one of
 * the right outcomes — a chat command handled inline, or a single OpenCode run
 * in the user's active session.
 *
 * The router never splits a Telegram message: the whole text (newlines
 * included) is delivered to OpenCode as ONE prompt.
 */

import {
  countMessages,
  getSession,
  getProject,
  getSetting,
  isAuthorized,
  listMessages,
  renameSession,
  setSetting,
  updateSessionModel,
  addMessage,
} from '../database/client.js';
import type { ChatMessage, RunProgress, RunResult, Session } from '../types.js';
import { ProcessManager } from '../cli/process-manager.js';
import { getConfig } from '../config/env.js';
import { PathSecurityError } from '../utils/paths.js';
import { createLogger } from '../utils/logger.js';
import { now } from '../utils/ids.js';
import { stripAnsi, truncateMiddle } from '../utils/telegram-text.js';
import { ProjectError, ProjectManager } from '../projects/project-manager.js';
import { getContainer } from '../context.js';

const log = createLogger('message-router');

/** Per-user "active session" pointer is persisted under this settings key. */
const ACTIVE_SESSION_PREFIX = 'active_session:';

/**
 * Per-user "selected project" pointer.
 *
 * Selecting a project must survive even when the project has NO sessions yet
 * (otherwise "new session" cannot know where to create one — the old logic
 * forgot the project as soon as the active session was cleared).
 */
const ACTIVE_PROJECT_PREFIX = 'active_project:';

/** Session names accepted by /rename. */
const SESSION_NAME_PATTERN = /^[\p{L}\p{N} _\-\.]{1,64}$/u;

/** `provider/model` shape accepted by /model. */
const MODEL_PATTERN = /^[\w.-]+\/[\w.-]+$/u;

/** Telegram-style command: `/name`, `/name@Bot`, `/name args`. */
const COMMAND_PATTERN = /^\/([A-Za-z]{1,24})(?:@\w+)?(?:\s+([\s\S]*))?$/;

/** How many messages /history summarises. */
const HISTORY_LIMIT = 15;

/** How many terminal lines /terminal dumps. */
const TERMINAL_LIMIT = 20;

/** Longest single history/terminal line before it is shortened. */
const PREVIEW_LIMIT = 200;

/** Outcome of routing one Telegram message. */
export type RouteOutcome =
  | { kind: 'routed'; result: RunResult; session: Session }
  | { kind: 'no_session' }
  | { kind: 'not_authorized' }
  | { kind: 'project_missing'; message: string }
  | { kind: 'command'; reply: string }
  | { kind: 'error'; message: string };

export interface RouteOptions {
  /**
   * Ask OpenCode to auto-approve tool calls.
   *
   * Defaults to the explicit user setting (`auto_approve`), which is OFF unless
   * enabled on purpose. Auto-approval lets the model write files and run
   * commands unattended, so it must never be the silent default.
   */
  autoApprove?: boolean;
  /** Live progress forwarded from the running CLI process. */
  onProgress?: (progress: RunProgress) => void;
}

type KnownCommand = 'rename' | 'model' | 'stop' | 'history' | 'terminal';

interface ParsedCommand {
  name: KnownCommand;
  argument: string | null;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class MessageRouter {
  private readonly projectsOverride: ProjectManager | undefined;

  private readonly processesOverride: ProcessManager | undefined;

  /**
   * Both dependencies are optional: the boot sequence constructs services with
   * `new MessageRouter()` before the container exists, so missing dependencies
   * are resolved lazily from the container at call time. Tests (and any custom
   * wiring) may inject explicit instances instead.
   */
  constructor(projects?: ProjectManager, processes?: ProcessManager) {
    this.projectsOverride = projects;
    this.processesOverride = processes;
  }

  private get projects(): ProjectManager {
    return this.projectsOverride ?? getContainer().projectManager;
  }

  private get processes(): ProcessManager {
    return this.processesOverride ?? getContainer().processManager;
  }

  // ── active session tracking (persisted in settings) ───────────────────────

  activeSessionId(telegramId: number): string | null {
    const raw = getSetting(ACTIVE_SESSION_PREFIX + telegramId);
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return null;
  }

  /**
   * Full record of the active session, or null when the pointer is unset or
   * stale (in which case the stale pointer is forgotten).
   */
  activeSession(telegramId: number): Session | null {
    const sessionId = this.activeSessionId(telegramId);
    if (!sessionId) return null;
    // SessionRow widens `status` to string; at runtime it only ever holds a
    // SessionStatus, so narrowing back down is safe.
    const session = getSession(sessionId) as Session | undefined;
    if (!session) {
      // The session was deleted meanwhile — forget the pointer.
      this.clearActiveSession(telegramId);
      return null;
    }
    return session;
  }

  setActiveSession(telegramId: number, sessionId: string): void {
    setSetting(ACTIVE_SESSION_PREFIX + telegramId, sessionId);
    // A session pins its own project: keep the project pointer in sync so the
    // "new session" flow always knows where it lives.
    const session = getSession(sessionId) as Session | undefined;
    if (session) this.setActiveProject(telegramId, session.projectId);
  }

  clearActiveSession(telegramId: number): void {
    setSetting(ACTIVE_SESSION_PREFIX + telegramId, '');
  }

  // ── active project tracking (persisted in settings) ───────────────────────

  activeProjectId(telegramId: number): string | null {
    const raw = getSetting(ACTIVE_PROJECT_PREFIX + telegramId);
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return null;
  }

  setActiveProject(telegramId: number, projectId: string): void {
    setSetting(ACTIVE_PROJECT_PREFIX + telegramId, projectId);
  }

  clearActiveProject(telegramId: number): void {
    setSetting(ACTIVE_PROJECT_PREFIX + telegramId, '');
  }

  /**
   * The project the user is currently working in: the active session's project
   * first, then the remembered selection. A stale pointer (project deleted) is
   * forgotten rather than reused.
   */
  resolveProjectId(telegramId: number): string | null {
    const session = this.activeSession(telegramId);
    if (session) return session.projectId;

    const projectId = this.activeProjectId(telegramId);
    if (!projectId) return null;
    if (!getProject(projectId)) {
      this.clearActiveProject(telegramId);
      return null;
    }
    return projectId;
  }

  // ── routing ───────────────────────────────────────────────────────────────

  /**
   * Route one text message. The whole message is sent as a single prompt —
   * newlines preserved, never split into multiple runs.
   */
  async route(telegramId: number, text: string, opts: RouteOptions = {}): Promise<RouteOutcome> {
    if (!isAuthorized(telegramId)) {
      log.warn({ telegramId }, 'unauthorized user attempted to route a message');
      return { kind: 'not_authorized' };
    }

    const message = typeof text === 'string' ? text : '';
    if (message.trim().length === 0) {
      return { kind: 'error', message: 'Пустое сообщение — отправьте задачу текстом.' };
    }

    try {
      const command = MessageRouter.parseCommand(message);
      if (command) {
        return await this.handleCommand(telegramId, command);
      }
      return await this.routePrompt(telegramId, message, opts);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.error({ err, telegramId }, 'message routing failed');
      return { kind: 'error', message: errMessage };
    }
  }

  /** Only the five known commands; anything else starting with `/` is a prompt. */
  private static parseCommand(text: string): ParsedCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    const match = COMMAND_PATTERN.exec(trimmed);
    const name = match?.[1]?.toLowerCase();
    const argument = match?.[2]?.trim() ?? null;
    switch (name) {
      case 'rename':
      case 'model':
      case 'stop':
      case 'history':
      case 'terminal':
        return { name, argument };
      default:
        return null;
    }
  }

  /** Resolve the user's active session, clearing stale pointers. */
  private resolveSession(telegramId: number): Session | null {
    return this.activeSession(telegramId);
  }

  /**
   * Effective auto-approve state for a run.
   *
   * The operator's `OPENCODE_ARGS=--auto` in .env is an explicit, deliberate
   * decision and therefore forces the mode on for every run; otherwise only the
   * per-user switch in ⚙️ Настройки turns it on. Off remains the default.
   */
  private static autoApproveEnabled(): boolean {
    if ((getSetting('auto_approve') ?? 'off') === 'on') return true;
    try {
      return getConfig().opencodeArgs.includes('--auto');
    } catch {
      // Configuration not loaded (isolated tests): fall back to the switch.
      return false;
    }
  }

  /** Core prompt path: verify project, persist, run, persist. */
  private async routePrompt(telegramId: number, message: string, opts: RouteOptions): Promise<RouteOutcome> {
    const autoApprove = opts.autoApprove ?? MessageRouter.autoApproveEnabled();
    const session = this.resolveSession(telegramId);
    if (!session) return { kind: 'no_session' };

    const project = getProject(session.projectId);
    if (!project) {
      return {
        kind: 'project_missing',
        message: `Проект сессии «${session.name}» не найден в базе. Переподключите каталог проекта.`,
      };
    }

    try {
      await this.projects.assertUsable(project);
    } catch (err) {
      if (err instanceof PathSecurityError) {
        return { kind: 'project_missing', message: `Небезопасный путь проекта: ${project.path}` };
      }
      if (err instanceof ProjectError && err.code === 'not_found') {
        return { kind: 'project_missing', message: err.message };
      }
      throw err;
    }

    // Persist the prompt first so it survives even if the run cannot start.
    addMessage({ sessionId: session.id, role: 'user', content: message });

    // One Telegram message = one OpenCode prompt. Never split.
    const handle = await this.processes.send({
      session,
      project,
      message,
      autoApprove,
      persist: false, // persistence is done here to keep a single owner of history
      onProgress: opts.onProgress,
    });
    const result = await handle.done;

    if (result.text.trim().length > 0) {
      addMessage({ sessionId: session.id, role: 'assistant', content: result.text });
    }

    // The session row may have been updated (opencodeSessionId, model, status).
    const fresh = (getSession(session.id) ?? session) as Session;
    return { kind: 'routed', result, session: fresh };
  }

  // ── inline chat commands ──────────────────────────────────────────────────

  private async handleCommand(telegramId: number, command: ParsedCommand): Promise<RouteOutcome> {
    switch (command.name) {
      case 'stop':
        return await this.commandStop(telegramId);
      case 'rename':
        return this.commandRename(telegramId, command.argument);
      case 'model':
        return this.commandModel(telegramId, command.argument);
      case 'history':
        return this.commandHistory(telegramId);
      case 'terminal':
        return this.commandTerminal(telegramId);
      default: {
        // Unreachable at runtime; keeps the switch exhaustive for TS.
        const exhaustive: never = command.name;
        return { kind: 'error', message: `Неизвестная команда: ${String(exhaustive)}` };
      }
    }
  }

  private async commandStop(telegramId: number): Promise<RouteOutcome> {
    const session = this.resolveSession(telegramId);
    if (!session) return { kind: 'no_session' };
    const cancelled = await this.processes.cancel(session.id, 'cancelled_by_user');
    const reply = cancelled
      ? `⏹ Задача в сессии «${session.name}» остановлена. Очередные сообщения продолжат выполняться.`
      : `В сессии «${session.name}» сейчас нет активной задачи.`;
    return { kind: 'command', reply };
  }

  private commandRename(telegramId: number, argument: string | null): RouteOutcome {
    const session = this.resolveSession(telegramId);
    if (!session) return { kind: 'no_session' };
    if (!argument || !SESSION_NAME_PATTERN.test(argument)) {
      return {
        kind: 'command',
        reply: 'Использование: /rename <новое имя> — 1–64 символа: буквы, цифры, пробел, «_», «-», «.».',
      };
    }
    renameSession(session.id, argument);
    return { kind: 'command', reply: `✅ Сессия переименована в «${argument}».` };
  }

  private commandModel(telegramId: number, argument: string | null): RouteOutcome {
    const session = this.resolveSession(telegramId);
    if (!session) return { kind: 'no_session' };
    if (!argument) {
      const current = session.model ?? 'по умолчанию (из конфигурации OpenCode)';
      return { kind: 'command', reply: `Текущая модель: ${current}.\nПереключение: /model provider/model` };
    }
    if (!MODEL_PATTERN.test(argument)) {
      return { kind: 'command', reply: 'Формат модели: provider/model, например anthropic/claude-sonnet-4.' };
    }
    updateSessionModel(session.id, argument);
    return { kind: 'command', reply: `🤖 Модель сессии «${session.name}» переключена на ${argument}.` };
  }

  private commandHistory(telegramId: number): RouteOutcome {
    const session = this.resolveSession(telegramId);
    if (!session) return { kind: 'no_session' };

    const total = countMessages(session.id);
    // MessageRow widens `role` to string; the stored values are ChatMessage roles.
    const recent = listMessages(session.id, HISTORY_LIMIT) as ChatMessage[];
    const header = `📜 История сессии «${session.name}» — всего ${total} сообщ., последние ${recent.length}:`;

    if (recent.length === 0) {
      return { kind: 'command', reply: `${header}\n(пока пусто)` };
    }

    const lines = recent.map((message) => {
      const icon = message.role === 'user' ? '👤' : message.role === 'assistant' ? '🤖' : '⚙️';
      const flat = message.content.replace(/\r?\n/g, ' ⏎ ');
      return `[${formatClock(message.createdAt)}] ${icon} ${truncateMiddle(stripAnsi(flat), PREVIEW_LIMIT)}`;
    });
    return { kind: 'command', reply: [header, ...lines].join('\n') };
  }

  private commandTerminal(telegramId: number): RouteOutcome {
    const session = this.resolveSession(telegramId);
    if (!session) return { kind: 'no_session' };

    const instance = this.processes.get(session.id);
    if (!instance || instance.buffer.length === 0) {
      return {
        kind: 'command',
        reply: `📟 Терминал сессии «${session.name}» пуст — процесс ещё не запускался.`,
      };
    }

    const tail = instance.buffer.slice(-TERMINAL_LIMIT);
    const lines = tail.map((line) => {
      const icon = line.role === 'user' ? '👤' : line.role === 'assistant' ? '🤖' : '📟';
      const flat = stripAnsi(line.text).replace(/\r?\n/g, ' ⏎ ');
      return `[${formatClock(line.at)}] ${icon} ${truncateMiddle(flat, PREVIEW_LIMIT)}`;
    });

    const busyNote = this.processes.isBusy(session.id)
      ? `\n\n⏳ Выполняется: ${instance.currentTask ?? 'активная задача'}`
      : '';
    const reply = `📟 Последние ${tail.length} строк терминала «${session.name}»:\n\n${lines.join('\n')}${busyNote}`;
    return { kind: 'command', reply };
  }

  // ── status ────────────────────────────────────────────────────────────────

  /** Human-readable status block for a session. */
  async summarizeStatus(sessionId: string): Promise<string> {
    const session = getSession(sessionId);
    if (!session) {
      return `Сессия ${sessionId} не найдена.`;
    }

    const project = getProject(session.projectId);
    const instance = this.processes.get(sessionId);
    const status = instance?.status ?? session.status;
    const model = session.model ?? 'по умолчанию (из конфигурации OpenCode)';
    const pid = instance?.pid;

    const lines: string[] = [
      '📊 Статус сессии',
      '',
      `📁 Проект: ${project?.name ?? '(не найден)'}`,
      `💬 Сессия: ${session.name}`,
      `🤖 Модель: ${model}`,
      `📊 Статус: ${status}`,
      `🔢 PID: ${pid != null ? String(pid) : '—'}`,
    ];

    if (instance?.startedAt) {
      lines.push(`⏱ Аптайм: ${MessageRouter.formatDuration(now() - instance.startedAt)}`);
    } else {
      lines.push('⏱ Аптайм: —');
    }

    if (instance?.currentTask) {
      lines.push(`🛠 Текущая задача: ${instance.currentTask}`);
    }

    const queued = this.processes.queueLength(sessionId);
    if (queued > 0) {
      lines.push(`📨 В очереди: ${queued}`);
    }

    if (!project) {
      lines.push('⚠️ Проект сессии не найден — переподключите каталог.');
    }

    return lines.join('\n');
  }

  private static formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds} с`;
    const minutes = Math.floor(totalSeconds / 60);
    if (minutes < 60) return `${minutes} мин ${totalSeconds % 60} с`;
    const hours = Math.floor(minutes / 60);
    return `${hours} ч ${minutes % 60} мин`;
  }
}
