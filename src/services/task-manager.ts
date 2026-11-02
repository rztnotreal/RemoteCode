/**
 * TaskManager turns runs into user-visible "in progress" states.
 *
 * It edits the triggering Telegram message into a live status block, keeps it
 * updated from ProcessManager events (throttled to respect Telegram rate
 * limits), and finally rewrites it into the full answer — long answers are
 * split with splitMessage and EVERY chunk is sent, nothing is truncated.
 *
 * Telegram is not imported here: the bot layer injects a sink factory, which
 * keeps this module testable and transport-agnostic.
 */

import { ProcessManager } from '../cli/process-manager.js';
import type {
  ProcessErrorEvent,
  ProcessFinishedEvent,
  ProcessProgressEvent,
} from '../cli/process-manager.js';
import type { Project, RunResult, Session } from '../types.js';
import { getContainer } from '../context.js';
import { createLogger } from '../utils/logger.js';
import { now } from '../utils/ids.js';
import { splitMessage, truncateMiddle } from '../utils/telegram-text.js';

const log = createLogger('task-manager');

/** Maximum edits per status message (one per this many ms). */
const DEFAULT_THROTTLE_MS = 2_000;

/** Status/elapsed refresh cadence. */
const DEFAULT_TICK_MS = 1_000;

/** Consecutive Telegram API failures before the live status is abandoned. */
const MAX_EDIT_FAILURES = 3;

/** Longest error snippet rendered in the final error block. */
const ERROR_LIMIT = 1_500;

/** A message bound to a specific chat/message pair (bot-provided). */
export interface StatusMessageRef {
  chatId: number;
  messageId: number;
}

/** The only Telegram-facing operations TaskManager needs. */
export interface MessageSink {
  edit(text: string, markup?: unknown): Promise<void>;
  send(text: string, markup?: unknown): Promise<void>;
}

/** Creates a sink bound to the status message being tracked. */
export type SinkFactory = (ref: StatusMessageRef) => MessageSink;

/** Callback-data contract shared with the bot layer's button handlers. */
export const TASK_CALLBACK_STOP = 'task:stop';
export const TASK_CALLBACK_TERMINAL = 'task:terminal';
export const TASK_CALLBACK_REFRESH = 'task:refresh';

/**
 * Telegram wire-format inline keyboard, kept structural (no grammy import).
 * The bot-side sink passes this straight through as `reply_markup`.
 */
export interface TaskKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TaskStartOptions {
  telegramId: number;
  chatId: number;
  messageId: number;
  session: Session;
  project: Project;
}

interface TaskState {
  sessionId: string;
  telegramId: number;
  ref: StatusMessageRef;
  sink: MessageSink;
  session: Session;
  project: Project;
  startedAt: number;
  lastEditAt: number;
  elapsedTimer: ReturnType<typeof setInterval> | null;
  /** Live description of what the run is doing right now. */
  currentTask: string | null;
  /** Consecutive sink.edit failures; abandoned after MAX_EDIT_FAILURES. */
  failures: number;
  /** True once the state is retired (finished or abandoned). */
  disposed: boolean;
}

export class TaskManager {
  private readonly states = new Map<string, TaskState>();

  private processesOverride: ProcessManager | undefined;

  private createSinkOverride: SinkFactory | undefined;

  private readonly throttleMs: number;

  private readonly tickMs: number;

  private subscribedToProcesses = false;

  /** The ProcessManager instance events were subscribed to (for clean teardown). */
  private subscribedInstance: ProcessManager | null = null;

  /**
   * The boot sequence constructs services with `new TaskManager()` BEFORE the
   * container is set, so the ProcessManager is resolved lazily from the
   * container at first use. The sink factory may be injected here, or attached
   * later via `setSinkFactory()` by the bot layer. All options are optional to
   * keep zero-argument construction valid.
   */
  constructor(options: {
    processes?: ProcessManager;
    createSink?: SinkFactory;
    throttleMs?: number;
    tickMs?: number;
  } = {}) {
    this.processesOverride = options.processes;
    this.createSinkOverride = options.createSink;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  private get processes(): ProcessManager {
    return this.processesOverride ?? getContainer().processManager;
  }

  private get createSink(): SinkFactory {
    if (this.createSinkOverride !== undefined) return this.createSinkOverride;
    throw new Error('TaskManager: sink factory is not configured — call setSinkFactory() first.');
  }

  /** Attach the Telegram sink factory (bot wiring) after construction. */
  setSinkFactory(factory: SinkFactory): void {
    this.createSinkOverride = factory;
  }

  /** Subscribe to ProcessManager events exactly once, on first use. */
  private ensureSubscribed(): void {
    if (this.subscribedToProcesses) return;
    const processes = this.processes;
    processes.on('progress', this.handleProgress);
    processes.on('finished', this.handleFinished);
    processes.on('error', this.handleRunError);
    processes.on('cancelled', this.handleRunCancelled);
    this.subscribedInstance = processes;
    this.subscribedToProcesses = true;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Edit the user's existing message into the "in progress" status block and
   * subscribe it to live ProcessManager progress until the run finishes.
   */
  async start(opts: TaskStartOptions): Promise<void> {
    this.ensureSubscribed();

    const existing = this.states.get(opts.session.id);
    if (existing) {
      // A newer run supersedes the previous status card.
      this.retire(existing);
    }

    const ref: StatusMessageRef = { chatId: opts.chatId, messageId: opts.messageId };
    const sink = this.createSink(ref);
    const timestamp = now();

    const state: TaskState = {
      sessionId: opts.session.id,
      telegramId: opts.telegramId,
      ref,
      sink,
      session: opts.session,
      project: opts.project,
      startedAt: timestamp,
      lastEditAt: timestamp,
      elapsedTimer: null,
      currentTask: null,
      failures: 0,
      disposed: false,
    };
    this.states.set(opts.session.id, state);

    state.elapsedTimer = setInterval(() => {
      void this.onTick(state);
    }, this.tickMs);
    state.elapsedTimer.unref();

    await this.performEdit(state, () => this.renderStatus(state), this.renderKeyboard());
  }

  /** True when a live status card is being tracked for the session. */
  isTracking(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  /**
   * Stop tracking a single session without rendering anything.
   *
   * Used when a run never actually started (validation failed after the card
   * was created), so the "in progress" card does not linger forever. Other
   * concurrently running sessions keep their cards.
   */
  abandon(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.retire(state);
    this.states.delete(sessionId);
    log.debug({ sessionId }, 'task tracking abandoned');
  }

  /** Stop tracking everything and unsubscribe from ProcessManager events. */
  dispose(): void {
    for (const state of [...this.states.values()]) {
      this.retire(state);
    }
    this.states.clear();
    const processes = this.subscribedInstance;
    if (processes) {
      processes.off('progress', this.handleProgress);
      processes.off('finished', this.handleFinished);
      processes.off('error', this.handleRunError);
      processes.off('cancelled', this.handleRunCancelled);
      this.subscribedInstance = null;
      this.subscribedToProcesses = false;
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private renderStatus(state: TaskState): string {
    const lines: string[] = [
      '🧩 OpenCode выполняет задачу',
      '',
      `📁 Проект: ${state.project.name}`,
      `💬 Сессия: ${state.session.name}`,
      `🤖 Модель: ${state.session.model ?? 'по умолчанию'}`,
      '📊 Статус: генерация',
      `⏱ ${TaskManager.formatDuration(now() - state.startedAt)}`,
    ];
    if (state.currentTask) {
      lines.push(`🛠 ${TaskManager.formatElapsedTask(state.currentTask)}`);
    }
    return lines.join('\n');
  }

  private renderKeyboard(): TaskKeyboard {
    return {
      inline_keyboard: [
        [
          { text: '⛔ Остановить', callback_data: TASK_CALLBACK_STOP },
          { text: '📟 Терминал', callback_data: TASK_CALLBACK_TERMINAL },
          { text: '🔄 Обновить', callback_data: TASK_CALLBACK_REFRESH },
        ],
      ],
    };
  }

  /** Final answer + tool list + completion notice (no truncation of the answer). */
  private composeSuccess(result: RunResult, elapsed: string): string {
    const tools = [...new Set(result.tools)];
    const toolLine =
      tools.length > 0
        ? `\n\n🧰 Инструменты: ${tools.slice(0, 10).join(', ')}${
            tools.length > 10 ? ` (+${tools.length - 10})` : ''
          }`
        : '';
    const notice = `\n\n✅ Готово за ${elapsed}.${toolLine}`;
    if (result.text.trim().length === 0) {
      return `✅ Задача завершена за ${elapsed}.${toolLine}`;
    }
    return `${result.text}${notice}`;
  }

  private composeError(result: RunResult, elapsed: string): string {
    const detail = truncateMiddle(result.error ?? 'Неизвестная ошибка CLI.', ERROR_LIMIT);
    const tools = [...new Set(result.tools)];
    const toolLine = tools.length > 0 ? `\n\n🧰 Инструменты: ${tools.join(', ')}` : '';
    const exit = result.exitCode !== null ? ` (код выхода ${result.exitCode})` : '';
    return `❌ Ошибка выполнения${exit}\n\n${detail}\n\n⏱ Длительность: ${elapsed}.${toolLine}`;
  }

  private composeCancelled(result: RunResult, elapsed: string): string {
    const header = `⏹ Задача остановлена пользователем (за ${elapsed}).`;
    if (result.text.trim().length > 0) {
      return `${result.text}\n\n${header}`;
    }
    return header;
  }

  // ── event handling ────────────────────────────────────────────────────────

  private readonly handleProgress = (event: ProcessProgressEvent): void => {
    const state = this.states.get(event.sessionId);
    if (!state || state.disposed) return;

    if (event.progress.kind === 'tool' && event.progress.tool) {
      state.currentTask = event.progress.tool;
    } else if (event.progress.kind === 'status' && event.progress.status) {
      state.currentTask = event.progress.status;
    }
    // Text progress keeps the elapsed counter fresh; the throttle below decides
    // whether this actually hits the Telegram API.
    void this.requestThrottledEdit(state);
  };

  /** Terminal events only paint extra detail; the final card is built in handleFinished. */
  private readonly handleRunError = (event: ProcessErrorEvent): void => {
    const state = this.states.get(event.sessionId);
    if (!state || state.disposed) return;
    state.currentTask = 'завершение с ошибкой…';
    log.debug({ sessionId: event.sessionId, error: event.error }, 'run error observed');
  };

  private readonly handleRunCancelled = (): void => {
    // Cancellation detail is rendered from RunResult in handleFinished; this
    // listener exists so the live card can stop showing a stale tool name.
  };

  private readonly handleFinished = async (event: ProcessFinishedEvent): Promise<void> => {
    const state = this.states.get(event.sessionId);
    if (!state || state.disposed) return;

    const elapsed = TaskManager.formatDuration(now() - state.startedAt);
    // Retire BEFORE the (possibly slow) Telegram calls: the card must not be
    // resurrected by late progress events while we are writing the final text.
    this.retire(state);

    try {
      const result = event.result;
      if (result.cancelled) {
        await state.sink.edit(this.composeCancelled(result, elapsed));
        return;
      }
      if (!result.ok) {
        await state.sink.edit(this.composeError(result, elapsed));
        return;
      }

      // Long answers: splitMessage yields chunks; EVERY chunk is delivered —
      // the first one edits the status card, the rest are sent as new messages.
      const chunks = splitMessage(this.composeSuccess(result, elapsed));
      const [first, ...rest] = chunks;
      if (first !== undefined) {
        await state.sink.edit(first);
        for (const chunk of rest) {
          await state.sink.send(chunk);
        }
      } else {
        await state.sink.edit(`✅ Задача завершена за ${elapsed}.`);
      }
    } catch (err) {
      // Message too old, edited too frequently, chat migrated — never fatal.
      log.debug({ err, sessionId: event.sessionId }, 'failed to render final task state');
    }
  };

  // ── throttled live updates ────────────────────────────────────────────────

  private readonly onTick = async (state: TaskState): Promise<void> => {
    if (state.disposed) return;
    await this.requestThrottledEdit(state);
  };

  /** Re-render the status card, at most once per throttle window. */
  private async requestThrottledEdit(state: TaskState): Promise<void> {
    if (state.disposed) return;
    if (now() - state.lastEditAt < this.throttleMs) return;
    await this.performEdit(state, () => this.renderStatus(state), this.renderKeyboard());
  }

  /**
   * Perform one sink.edit with failure bookkeeping. Telegram API errors are
   * logged at debug and swallowed — a stale status card must never crash the
   * bot. After MAX_EDIT_FAILURES consecutive failures tracking is abandoned
   * (e.g. the message is too old to edit any more).
   */
  private async performEdit(
    state: TaskState,
    render: () => string,
    markup: TaskKeyboard | undefined,
  ): Promise<void> {
    if (state.disposed) return;
    state.lastEditAt = now();
    try {
      await state.sink.edit(render(), markup);
      state.failures = 0;
    } catch (err) {
      state.failures += 1;
      log.debug(
        { err, sessionId: state.sessionId, failures: state.failures },
        'status message edit failed',
      );
      if (state.failures >= MAX_EDIT_FAILURES) {
        log.debug({ sessionId: state.sessionId }, 'abandoning live status card');
        this.retire(state);
      }
    }
  }

  /** Stop timers and untrack; final renders use the retained state object. */
  private retire(state: TaskState): void {
    if (state.elapsedTimer !== null) {
      clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
    state.disposed = true;
    if (this.states.get(state.sessionId) === state) {
      this.states.delete(state.sessionId);
    }
  }

  // ── formatting ────────────────────────────────────────────────────────────

  private static formatElapsedTask(task: string): string {
    return truncateMiddle(task.replace(/\r?\n/g, ' '), 120);
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
