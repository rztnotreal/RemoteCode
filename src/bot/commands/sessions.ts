import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import { sessionsKeyboard, sessionActionsKeyboard } from '../keyboards/menus.js';
import { beginSessionCreate, beginSessionRename, safeEdit } from './projects.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('bot:sessions');

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function showSessions(ctx: Context, page = 0): Promise<void> {
  const { messageRouter, projectManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const active = await messageRouter.activeSession(telegramId);
  const { listSessions } = await import('../../database/client.js');

  // The header follows the SELECTED PROJECT (active session first, remembered
  // selection second), so a project with zero sessions still renders correctly.
  const projectId = messageRouter.resolveProjectId(telegramId);
  const project = projectId ? await projectManager.get(projectId) : undefined;
  const rows = project ? listSessions(project.id) : [];
  const sessions = rows.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    model: s.model,
  }));

  const header = project
    ? `💬 <b>Сессии</b>\n\nПроект: ${escapeHtml(project.name)}\nВсего: ${sessions.length}`
    : '💬 <b>Сессии</b>\n\nСначала выберите проект на экране «📁 Проекты».';
  const text = sessions.length === 0 ? `${header}\n\nСессий пока нет — создайте первую.` : header;

  const keyboard = sessionsKeyboard(sessions, page, active?.id ?? null);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
    await ctx.answerCallbackQuery().catch(() => undefined);
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function showSessionActions(ctx: Context, sessionId: string): Promise<void> {
  const { getSession } = await import('../../database/client.js');
  const { processManager } = getContainer();
  const session = getSession(sessionId);
  if (!session) {
    await safeEdit(ctx, '⚠️ Сессия не найдена.', CB.sessionsList);
    return;
  }

  const snapshot = processManager.snapshot(sessionId);
  const lines = [
    `💬 <b>${escapeHtml(session.name)}</b>`,
    '',
    `Статус: ${escapeHtml(session.status)}`,
    `Модель: ${escapeHtml(session.model ?? 'по умолчанию')}`,
    `PID: ${snapshot?.pid ?? 'не запущен'}`,
    snapshot?.currentTask ? `Задача: ${escapeHtml(snapshot.currentTask)}` : 'Задача: —',
  ];

  await safeEdit(ctx, lines.join('\n'), CB.sessionsList);
  if (ctx.callbackQuery) {
    await ctx.editMessageReplyMarkup({ reply_markup: sessionActionsKeyboard(sessionId) }).catch(() => undefined);
  }
}

export async function requestSessionCreate(ctx: Context): Promise<void> {
  const { messageRouter, projectManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  // The project comes from the active session OR from the remembered project
  // selection — a freshly selected project with zero sessions must work too.
  const projectId = messageRouter.resolveProjectId(telegramId);
  if (!projectId) {
    await safeEdit(ctx, '⚠️ Сначала выберите проект.', CB.projectsList);
    return;
  }

  const project = await projectManager.get(projectId);
  if (!project) {
    messageRouter.clearActiveProject(telegramId);
    await safeEdit(ctx, '⚠️ Проект не найден. Выберите проект заново.', CB.projectsList);
    return;
  }

  await beginSessionCreate(ctx, projectId);
}

export async function requestSessionRename(ctx: Context, sessionId: string): Promise<void> {
  await beginSessionRename(ctx, sessionId);
}

/**
 * Actually creates the session row. The native OpenCode session id is left
 * null on purpose: OpenCode creates it on the first prompt, so we never store
 * an id that does not exist yet.
 *
 * The model defaults to the user's stored choice (`default_model:<id>`, set in
 * 🤖 Модели when no session was active), otherwise OpenCode's own default.
 */
export async function createSession(ctx: Context, projectId: string, name: string): Promise<void> {
  const { createSession: insertSession, touchSession, getSetting } = await import(
    '../../database/client.js'
  );

  const telegramId = ctx.from?.id;
  const defaultModel =
    telegramId !== undefined ? (getSetting(`default_model:${telegramId}`) ?? null) : null;

  const session = insertSession({ projectId, name, model: defaultModel, opencodeSessionId: null });
  touchSession(session.id);
  log.info({ projectId, sessionId: session.id, name, model: defaultModel }, 'session created');

  await safeEdit(ctx, `✅ Сессия <b>${escapeHtml(name)}</b> создана.`, CB.sessionsList);
  await showSessions(ctx);
}

export async function renameSession(ctx: Context, sessionId: string, name: string): Promise<void> {
  const { renameSession: doRename } = await import('../../database/client.js');
  doRename(sessionId, name);
  log.info({ sessionId, name }, 'session renamed');
  await safeEdit(ctx, `✅ Переименовано в <b>${escapeHtml(name)}</b>.`, CB.sessionsList);
  await showSessionActions(ctx, sessionId);
}

export async function endSession(ctx: Context, sessionId: string): Promise<void> {
  const { processManager, messageRouter, terminalSessions } = getContainer();

  // Stop any live process first so we never orphan a CLI child (both Chat Mode
  // runs and the Terminal Mode PTY belong to this session).
  await processManager.cancel(sessionId, 'session_closed');
  await processManager.flushQueue(sessionId);
  terminalSessions.stop(sessionId);

  const telegramId = ctx.from?.id;
  if (telegramId !== undefined) {
    const active = await messageRouter.activeSession(telegramId);
    if (active?.id === sessionId) await messageRouter.clearActiveSession(telegramId);
  }

  await safeEdit(ctx, '⛔ Сессия завершена. Процесс OpenCode остановлен.', CB.sessionsList);
  await showSessions(ctx);
}

export async function showHistory(ctx: Context, sessionId: string): Promise<void> {
  const { sessionManager } = getContainer();
  const { getSession } = await import('../../database/client.js');
  const session = getSession(sessionId);
  if (!session) {
    await safeEdit(ctx, '⚠️ Сессия не найдена.', CB.sessionsList);
    return;
  }

  const { listMessages } = await import('../../database/client.js');
  let history = listMessages(sessionId, 20).map((m) => ({ role: m.role, text: m.content }));

  if (history.length === 0 && session.opencodeSessionId) {
    const project = await getContainer().projectManager.get(session.projectId);
    if (project) {
      history = await sessionManager.history(project.path, session.opencodeSessionId);
    }
  }

  if (history.length === 0) {
    await safeEdit(ctx, '📜 История пуста.', CB.sessionsList);
    return;
  }

  const body = history
    .slice(-10)
    .map((m) => {
      const who = m.role === 'user' ? '👤' : m.role === 'assistant' ? '🤖' : 'ℹ️';
      return `${who} <b>${m.role}</b>\n${escapeHtml(m.text.slice(0, 1500))}`;
    })
    .join('\n\n');

  await safeEdit(ctx, `📜 <b>История</b>\n\n${body}`, CB.sessionsList);
}
