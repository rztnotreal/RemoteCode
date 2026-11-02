import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import { modelsKeyboard } from '../keyboards/menus.js';
import { safeEdit } from './projects.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('bot:models');

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function showModels(
  ctx: Context,
  page = 0,
  options: { refresh?: boolean } = {},
): Promise<void> {
  const { modelManager, messageRouter, processManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  let models: Array<{ id: string; display: string }> = [];
  let listError: string | null = null;

  try {
    const raw = await modelManager.list({ refresh: options.refresh === true });
    models = raw.map((m) => ({ id: m.id, display: modelManager.formatDisplay(m.id) }));
  } catch (error) {
    listError = error instanceof Error ? error.message : String(error);
    log.warn({ err: listError }, 'failed to list models');
  }

  const active = await messageRouter.activeSession(telegramId);
  const currentModel = active?.model ?? null;
  const currentDisplay = currentModel ? modelManager.formatDisplay(currentModel) : 'по умолчанию';

  const lines = [
    '🤖 <b>Модели</b>',
    '',
    `Текущая: ${escapeHtml(currentDisplay)}`,
    active ? `Сессия: ${escapeHtml(active.name)}` : 'Сессия не выбрана — модель применится к следующей задаче.',
    '',
    listError
      ? `⚠️ Не удалось получить список моделей: ${escapeHtml(listError)}`
      : `Доступно: ${models.length}`,
    '',
    'Смена модели передаётся в OpenCode через <code>--model</code> при следующем запуске задачи, поэтому контекст сессии сохраняется.',
  ];

  const keyboard = modelsKeyboard(models, page, currentModel);
  await safeEdit(ctx, lines.join('\n'), CB.navMain);
  if (ctx.callbackQuery) {
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
  }

  void processManager;
}

/**
 * Applies the model choice.
 *
 * Two cases:
 *  - a session is selected  → persist it on the session; the next `run` uses
 *    `-m <model>` while resuming the SAME OpenCode session id, so context is
 *    kept by the CLI itself, not by us;
 *  - no session              → store as the user's default for the next session.
 */
export async function selectModel(ctx: Context, modelId: string): Promise<void> {
  const { modelManager, messageRouter } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  try {
    await modelManager.resolve(modelId);
  } catch {
    await safeEdit(ctx, `⚠️ Неизвестная модель: <code>${escapeHtml(modelId)}</code>`, CB.modelsList);
    return;
  }

  const active = await messageRouter.activeSession(telegramId);
  const { setSetting, updateSessionModel } = await import('../../database/client.js');

  if (active) {
    updateSessionModel(active.id, modelId);
    setSetting(`default_model:${telegramId}`, modelId);
    log.info({ sessionId: active.id, model: modelId }, 'model switched for active session');
    await safeEdit(
      ctx,
      `✅ Модель сессии <b>${escapeHtml(active.name)}</b> изменена на <b>${escapeHtml(modelManager.formatDisplay(modelId))}</b>.\n\n` +
        'Контекст сессии сохранён — изменение применится к следующей задаче.',
      CB.sessionsList,
    );
    return;
  }

  setSetting(`default_model:${telegramId}`, modelId);
  log.info({ model: modelId }, 'default model stored (no active session)');
  await safeEdit(
    ctx,
    `✅ Модель <b>${escapeHtml(modelManager.formatDisplay(modelId))}</b> сохранена как модель по умолчанию.\n` +
      'Она будет использована для новых сессий.',
    CB.modelsList,
  );
}
