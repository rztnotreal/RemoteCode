import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import { terminalKeyboard } from '../keyboards/terminal.js';
import { beginTerminalInput, safeEdit } from './projects.js';
import { stripAnsi } from '../../utils/telegram-text.js';
import { escapeHtml } from '../../utils/html.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('bot:terminal');

const PAGE_LINES = 20;

/**
 * Terminal Mode (secondary to Chat Mode).
 *
 * Renders the virtual terminal screen maintained by the PTY adapter. Raw ANSI
 * never reaches Telegram: the screen renderer already returns plain text and
 * `stripAnsi` is applied again as a belt-and-braces guard.
 */
export async function showTerminal(ctx: Context, page = 0): Promise<void> {
  const { messageRouter, terminalSessions } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const session = await messageRouter.activeSession(telegramId);
  if (!session) {
    await safeEdit(
      ctx,
      '📟 <b>Терминал</b>\n\nАктивная сессия не выбрана.\nСначала выберите проект и сессию.',
      CB.navMain,
    );
    return;
  }

  const lines = terminalSessions.terminalLines(session.id, PAGE_LINES * 6);

  const info = terminalSessions.info(session.id);
  const running = terminalSessions.isRunning(session.id);

  const pages = Math.max(1, Math.ceil(lines.length / PAGE_LINES));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const from = Math.max(0, lines.length - (safePage + 1) * PAGE_LINES);
  const to = lines.length - safePage * PAGE_LINES;
  const visible = lines.slice(from, Math.max(from, to));

  const header = [
    '📟 <b>Терминал</b>',
    `Сессия: ${escapeHtml(session.name)}`,
    running
      ? `PID: ${info?.pid ?? '—'} · запущен ${new Date(info?.startedAt ?? Date.now()).toLocaleTimeString('ru-RU')}`
      : 'Процесс не запущен',
    pages > 1 ? `Страница: ${safePage + 1}/${pages}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const body = !running
    ? '<i>Терминал не запущен. Нажмите «▶️ Запустить», чтобы открыть TUI OpenCode в этой директории.</i>'
    : visible.length === 0
      ? '<i>Экран пуст. Отправьте строку или клавишу, чтобы появился вывод.</i>'
      : `<code>${escapeHtml(stripAnsi(visible.join('\n')))}</code>`;

  await safeEdit(ctx, `${header}\n${body}`, CB.navMain);
  if (ctx.callbackQuery) {
    await ctx
      .editMessageReplyMarkup({ reply_markup: terminalKeyboard(safePage, pages, running) })
      .catch(() => undefined);
  }

  log.debug({ sessionId: session.id, lines: lines.length, page: safePage, running }, 'terminal rendered');
}

/** Spawns (or reuses) the interactive OpenCode TUI for the active session. */
export async function launchTerminal(ctx: Context): Promise<void> {
  const { messageRouter, terminalSessions, projectManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const session = await messageRouter.activeSession(telegramId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Нет активной сессии' }).catch(() => undefined);
    return;
  }

  const project = await projectManager.get(session.projectId);
  if (!project) {
    await ctx.answerCallbackQuery({ text: 'Проект не найден' }).catch(() => undefined);
    return;
  }

  try {
    await projectManager.assertUsable(project);
    terminalSessions.ensure(session, project);
    await ctx.answerCallbackQuery({ text: 'Терминал запущен' }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ err: message }, 'failed to launch terminal');
    await ctx.answerCallbackQuery({ text: message.slice(0, 180) }).catch(() => undefined);
    return;
  }

  await showTerminal(ctx);
}

/** Forwards a curated special key to the PTY of the active session. */
export async function sendTerminalKey(ctx: Context, key: string): Promise<void> {
  const { messageRouter, terminalSessions } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const session = await messageRouter.activeSession(telegramId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Нет активной сессии' }).catch(() => undefined);
    return;
  }

  const sent = await terminalSessions.sendKey(session.id, key);
  await ctx
    .answerCallbackQuery({ text: sent ? `Клавиша ${key} отправлена` : 'Сначала запустите терминал' })
    .catch(() => undefined);

  if (sent) await showTerminal(ctx);
}

export function requestTerminalInput(ctx: Context): void {
  beginTerminalInput(ctx);
}
