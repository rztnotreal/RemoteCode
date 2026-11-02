import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import {
  beginProjectAttach,
  beginProjectCreate,
  clearPending,
  showProjects,
} from '../commands/projects.js';
import {
  createSession,
  endSession,
  renameSession,
  requestSessionCreate,
  requestSessionRename,
  showHistory,
  showSessionActions,
  showSessions,
} from '../commands/sessions.js';
import { selectModel, showModels } from '../commands/models.js';
import { setAutoApprove, setMarkdownReplies, showSettings } from '../commands/settings.js';
import { enterDir, goUp, sendFile, sendProjectZip, showFiles } from '../commands/files.js';
import { showStatus } from '../commands/status.js';
import { sendTerminalKey, showTerminal, launchTerminal } from '../commands/terminal.js';
import { handleStart } from '../commands/start.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('bot:callback');

/** Splits `a:b:c` into a prefix and the remainder, keeping colons in the rest. */
function splitAction(data: string): { prefix: string; rest: string } {
  const idx = data.indexOf(':');
  if (idx < 0) return { prefix: data, rest: '' };
  return { prefix: data.slice(0, idx), rest: data.slice(idx + 1) };
}

export async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  // Navigating away invalidates a half-finished text flow, so a pending
  // "project name" or "terminal line" can never be consumed by an unrelated
  // screen later on.
  if (
    !data.startsWith('projects:new') &&
    !data.startsWith('projects:attach') &&
    !data.startsWith('sessions:new') &&
    !data.startsWith('sessions:rename') &&
    !data.startsWith('term:input')
  ) {
    clearPending(telegramId);
  }

  try {
    await dispatch(ctx, data);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error), data }, 'callback failed');
    await ctx.answerCallbackQuery({ text: '⚠️ Произошла ошибка' }).catch(() => undefined);
  }
}

async function dispatch(ctx: Context, data: string): Promise<void> {
  const { prefix, rest } = splitAction(data);

  switch (prefix) {
    case 'nav':
      if (rest === 'main') return handleStart(ctx);
      return;

    case 'noop':
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;

    case 'projects':
      switch (rest) {
        case 'list':
          return showProjects(ctx);
        case 'new':
          return beginProjectCreate(ctx);
        case 'attach':
          return beginProjectAttach(ctx);
        default: {
          if (rest.startsWith('page:')) return showProjects(ctx, Number(rest.slice(5)) || 0);
          if (rest.startsWith('del:')) return removeProject(ctx, rest.slice(4));
          if (rest.startsWith('sel:')) return selectProject(ctx, rest.slice(4));
          return;
        }
      }

    case 'sessions':
      switch (rest) {
        case 'list':
          return showSessions(ctx);
        case 'new':
          return requestSessionCreate(ctx);
        default: {
          if (rest.startsWith('page:')) return showSessions(ctx, Number(rest.slice(5)) || 0);
          if (rest.startsWith('sel:')) return selectSession(ctx, rest.slice(4));
          if (rest.startsWith('rename:')) return requestSessionRename(ctx, rest.slice(7));
          if (rest.startsWith('end:')) return endSession(ctx, rest.slice(4));
          if (rest.startsWith('hist:')) return showHistory(ctx, rest.slice(5));
          return;
        }
      }

    case 'models':
      // `models:list` is also the "🔄 Обновить список" button → bypass the cache.
      if (rest === 'list') return showModels(ctx, 0, { refresh: true });
      if (rest.startsWith('page:')) return showModels(ctx, Number(rest.slice(5)) || 0);
      if (rest.startsWith('set:')) return selectModel(ctx, rest.slice(4));
      return;

    case 'settings':
      if (rest === 'main') return showSettings(ctx);
      if (rest === 'auto:on') return setAutoApprove(ctx, true);
      if (rest === 'auto:off') return setAutoApprove(ctx, false);
      if (rest === 'md:on') return setMarkdownReplies(ctx, true);
      if (rest === 'md:off') return setMarkdownReplies(ctx, false);
      return;

    case 'files':
      switch (rest) {
        case 'list':
          return showFiles(ctx);
        case 'up':
          return goUp(ctx);
        case 'zip':
          return sendProjectZip(ctx);
        default: {
          if (rest.startsWith('page:')) return showFiles(ctx, Number(rest.slice(5)) || 0);
          if (rest.startsWith('cd:')) return enterDir(ctx, Number(rest.slice(3)));
          if (rest.startsWith('open:')) return sendFile(ctx, Number(rest.slice(5)));
          return;
        }
      }

    case 'term':
      if (rest === 'show') return showTerminal(ctx);
      if (rest === 'launch') return launchTerminal(ctx);
      if (rest === 'close') return closeTerminal(ctx);
      if (rest.startsWith('page:')) return showTerminal(ctx, Number(rest.slice(5)) || 0);
      if (rest.startsWith('key:')) return sendTerminalKey(ctx, rest.slice(4));
      return;

    case 'status':
      if (rest === 'show') return showStatus(ctx);
      return;

    case 'task':
      if (rest === 'stop') return stopTask(ctx);
      if (rest === 'refresh') return showStatus(ctx);
      if (rest === 'terminal') return showTerminal(ctx);
      return;

    default:
      log.debug({ data }, 'unhandled callback action');
      await ctx.answerCallbackQuery({ text: 'Неизвестное действие' }).catch(() => undefined);
  }
}

async function selectProject(ctx: Context, projectId: string): Promise<void> {
  const { projectManager, messageRouter } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const project = await projectManager.get(projectId);
  if (!project) {
    await ctx.answerCallbackQuery({ text: 'Проект не найден' }).catch(() => undefined);
    return;
  }

  try {
    // Fail fast and loudly if the directory vanished on disk.
    await projectManager.assertUsable(project);
  } catch (error) {
    await ctx
      .answerCallbackQuery({ text: error instanceof Error ? error.message : 'Директория недоступна' })
      .catch(() => undefined);
    return;
  }

  // Selecting a project ALWAYS remembers it (even with zero sessions) so the
  // "new session" flow knows where to create the first one. The active session
  // pointer still points at this project's most recent session, otherwise it
  // is cleared so the user picks explicitly.
  messageRouter.setActiveProject(telegramId, project.id);

  const { listSessions } = await import('../../database/client.js');
  const rows = listSessions(project.id);
  const latest = rows[0];

  if (latest) {
    await messageRouter.setActiveSession(telegramId, latest.id);
  } else {
    await messageRouter.clearActiveSession(telegramId);
  }

  await ctx.answerCallbackQuery({ text: `Проект: ${project.name}` }).catch(() => undefined);
  await showSessions(ctx);
}

async function selectSession(ctx: Context, sessionId: string): Promise<void> {
  const { messageRouter, projectManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const { getSession } = await import('../../database/client.js');
  const session = getSession(sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Сессия не найдена' }).catch(() => undefined);
    return;
  }

  const project = await projectManager.get(session.projectId);
  if (!project) {
    await ctx.answerCallbackQuery({ text: 'Проект не найден' }).catch(() => undefined);
    return;
  }

  await messageRouter.setActiveSession(telegramId, sessionId);

  // After a RemoteCode restart the stored OS pid is meaningless, so the ONLY
  // recovery path is the official CLI. Ask OpenCode whether the stored native
  // session still exists BEFORE promising the user their context is back.
  const context = await verifyStoredContext(sessionId);

  await ctx.answerCallbackQuery({ text: `Сессия: ${session.name}` }).catch(() => undefined);
  await showSessionActions(ctx, sessionId);

  if (context === 'lost') {
    await ctx
      .reply(
        '⚠️ <b>Контекст OpenCode не восстановлен</b>\n\n' +
          'CLI сообщает, что сохранённая сессия OpenCode не найдена ' +
          '(возможно, она была удалена или пересоздана в другой директории).\n\n' +
          'История RemoteCode сохранена, но продолжить ту же нативную сессию нельзя — ' +
          'следующая задача начнёт новую сессию OpenCode. Иллюзии сохранённого ' +
          'контекста мы не создаём.',
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  }
}

/**
 * Checks the stored native session id through the CLI.
 * Returns `'ok'` (resumable), `'unknown'` (no id stored / CLI unreachable) or
 * `'lost'` (CLI confirms the session is gone — the stored id is cleared so a
 * stale id is never silently re-created as an empty session).
 */
async function verifyStoredContext(sessionId: string): Promise<'ok' | 'unknown' | 'lost'> {
  const { sessionManager, projectManager } = getContainer();
  const { getSession, setOpencodeSessionId } = await import('../../database/client.js');

  const session = getSession(sessionId);
  if (!session?.opencodeSessionId) return 'unknown';

  const project = await projectManager.get(session.projectId);
  if (!project) return 'unknown';

  try {
    const check = await sessionManager.verifyContext(
      project.path,
      session.opencodeSessionId,
      project.path,
    );
    if (check === 'missing' || check === 'mismatch') {
      setOpencodeSessionId(sessionId, null);
      log.warn(
        { sessionId, opencodeSessionId: session.opencodeSessionId, check },
        'stored opencode session is not resumable — cleared',
      );
      return 'lost';
    }
    return 'ok';
  } catch (error) {
    // `unavailable`: the CLI could not be queried — keep the stored id intact.
    log.warn({ err: error instanceof Error ? error.message : String(error) }, 'context check failed');
    return 'unknown';
  }
}

async function closeTerminal(ctx: Context): Promise<void> {
  const { messageRouter, terminalSessions } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const session = await messageRouter.activeSession(telegramId);
  const closed = session ? terminalSessions.stop(session.id) : false;
  await ctx
    .answerCallbackQuery({ text: closed ? 'Терминал закрыт' : 'Терминал не был запущен' })
    .catch(() => undefined);
  await showTerminal(ctx);
}

async function removeProject(ctx: Context, projectId: string): Promise<void> {
  const { projectManager, messageRouter } = getContainer();
  const telegramId = ctx.from?.id;
  await projectManager.remove(projectId, { deleteFiles: false });
  // Drop the remembered selection if it pointed at the removed project.
  if (telegramId !== undefined && messageRouter.activeProjectId(telegramId) === projectId) {
    messageRouter.clearActiveProject(telegramId);
  }
  await ctx.answerCallbackQuery({ text: 'Проект отвязан' }).catch(() => undefined);
  await showProjects(ctx);
}

async function stopTask(ctx: Context): Promise<void> {
  const { messageRouter, processManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const session = await messageRouter.activeSession(telegramId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Нет активной сессии' }).catch(() => undefined);
    return;
  }

  const stopped = await processManager.cancel(session.id, 'stopped_by_user');
  await ctx
    .answerCallbackQuery({ text: stopped ? '⛔ Задача остановлена' : 'Нечего останавливать' })
    .catch(() => undefined);

  log.info({ sessionId: session.id, stopped }, 'task stopped by user');
  await showStatus(ctx);
}
