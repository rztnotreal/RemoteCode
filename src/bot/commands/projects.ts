import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import { projectsKeyboard } from '../keyboards/menus.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('bot:projects');

/** State machine for the two-step flows (create project / attach directory). */
type PendingFlow =
  | { kind: 'project:new' }
  | { kind: 'project:attach' }
  | { kind: 'session:new'; projectId: string }
  | { kind: 'session:rename'; sessionId: string }
  | { kind: 'terminal:input' };

const pending = new Map<number, PendingFlow>();

export function setPending(telegramId: number, flow: PendingFlow | null): void {
  if (flow === null) pending.delete(telegramId);
  else pending.set(telegramId, flow);
}

export function getPending(telegramId: number): PendingFlow | undefined {
  return pending.get(telegramId);
}

export function clearPending(telegramId: number): void {
  pending.delete(telegramId);
}

export async function showProjects(ctx: Context, page = 0): Promise<void> {
  const { projectManager, messageRouter } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const projects = await projectManager.list();
  const active = await messageRouter.activeSession(telegramId);
  // Highlight the selected project even when no session is active yet.
  const selectedId = messageRouter.resolveProjectId(telegramId) ?? undefined;
  const text =
    projects.length === 0
      ? '📁 <b>Проекты</b>\n\nПроектов пока нет. Создайте новый проект или добавьте существующую директорию.'
      : `📁 <b>Проекты</b>\n\nВсего: ${projects.length}\n\nВыберите проект, чтобы открыть его сессии.`;

  const markup = projectsKeyboard(projects, page, selectedId ?? active?.projectId);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup });
    });
    await ctx.answerCallbackQuery().catch(() => undefined);
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup });
  }
}

export async function beginProjectCreate(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  setPending(telegramId, { kind: 'project:new' });
  const text =
    '➕ <b>Новый проект</b>\n\n' +
    'Отправьте имя проекта. RemoteCode создаст папку с этим именем внутри каталога проектов и запустит OpenCode именно в ней.\n\n' +
    'Имя: буквы, цифры, пробел, <code>_ - .</code>, до 64 символов.\n' +
    'Для отмены отправьте /cancel.';

  await safeEdit(ctx, text, CB.projectsList);
}

export async function beginProjectAttach(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  setPending(telegramId, { kind: 'project:attach' });
  const text =
    '📂 <b>Добавить директорию</b>\n\n' +
    'Отправьте полный путь к уже существующей директории, в которой будет работать OpenCode.\n\n' +
    'Пример: <code>D:\\Projects\\NeedRP</code>\n' +
    'Для отмены отправьте /cancel.';

  await safeEdit(ctx, text, CB.projectsList);
}

export async function beginSessionCreate(ctx: Context, projectId: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  setPending(telegramId, { kind: 'session:new', projectId });
  const text =
    '➕ <b>Новая сессия</b>\n\n' +
    'Отправьте название сессии, например «Разработка авторизации».\n\n' +
    'Каждая сессия — независимый контекст OpenCode с собственным процессом.\n' +
    'Для отмены отправьте /cancel.';

  await safeEdit(ctx, text, CB.sessionsList);
}

export async function beginSessionRename(ctx: Context, sessionId: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  setPending(telegramId, { kind: 'session:rename', sessionId });
  await safeEdit(ctx, '📝 Отправьте новое название сессии. Для отмены — /cancel.', CB.sessionsList);
}

export function beginTerminalInput(ctx: Context): void {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  setPending(telegramId, { kind: 'terminal:input' });
}

/**
 * Shared guard: any non-command message while a flow is pending is consumed by
 * that flow instead of being routed to OpenCode. This is what prevents an
 * accidental "project name" from being sent to the model.
 */
export async function safeEdit(ctx: Context, text: string, backTarget?: string): Promise<void> {
  const { mainKeyboard } = await import('../keyboards/index.js');
  const markup = backTarget ? (await import('../keyboards/index.js')).backKeyboard(backTarget) : undefined;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup });
    });
    await ctx.answerCallbackQuery().catch(() => undefined);
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup ?? mainKeyboard() });
  }
  log.debug({ backTarget }, 'rendered safe edit');
}
