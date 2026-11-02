import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { mainKeyboard } from '../keyboards/index.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * /start — always shows the true current state: which project and session are
 * active right now and which model OpenCode will use. Nothing is faked when a
 * session is missing; the user simply sees that nothing is selected yet.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const { messageRouter, modelManager, processManager } = getContainer();

  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const session = await messageRouter.activeSession(telegramId);
  const snapshot = session ? processManager.snapshot(session.id) : undefined;

  const project = session ? await getContainer().projectManager.get(session.projectId) : undefined;
  const model = session?.model ? modelManager.formatDisplay(session.model) : 'по умолчанию';

  const statusText = snapshot?.status === 'running' ? '🟢 выполняет задачу' : 'Online';

  const lines = [
    '<b>RemoteCode</b>',
    '',
    `Статус: ${statusText}`,
    `Проект: ${escapeHtml(project?.name ?? '—')}`,
    `Сессия: ${escapeHtml(session?.name ?? '—')}`,
    `Модель: ${escapeHtml(model)}`,
  ];

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: mainKeyboard() });
}
