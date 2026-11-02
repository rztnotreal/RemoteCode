import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import { safeEdit } from './projects.js';

/**
 * Status screen — reports the REAL state of the OpenCode child process:
 * pid, uptime, current operation. When nothing runs, it says so instead of
 * pretending everything is fine.
 */
export async function showStatus(ctx: Context): Promise<void> {
  const { messageRouter, processManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const session = await messageRouter.activeSession(telegramId);

  if (!session) {
    await safeEdit(
      ctx,
      '📊 <b>Статус</b>\n\nАктивная сессия не выбрана.\nПроцесс OpenCode не запущен.',
      CB.navMain,
    );
    return;
  }

  const snapshot = processManager.snapshot(session.id);
  const summary = await messageRouter.summarizeStatus(session.id);

  const uptime =
    snapshot?.startedAt !== null && snapshot?.startedAt !== undefined
      ? formatDuration(Date.now() - snapshot.startedAt)
      : '—';

  const lines = [
    '📊 <b>Статус</b>',
    '',
    summary,
    '',
    `PID: ${snapshot?.pid ?? 'процесс не запущен'}`,
    `Время работы: ${uptime}`,
    `Задача: ${snapshot?.currentTask ?? '—'}`,
    `Последняя активность: ${
      snapshot ? new Date(snapshot.lastActivityAt).toLocaleString('ru-RU') : '—'
    }`,
  ];

  await safeEdit(ctx, lines.join('\n'), CB.navMain);
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} ч`);
  if (m > 0) parts.push(`${m} мин`);
  parts.push(`${s} сек`);
  return parts.join(' ');
}
