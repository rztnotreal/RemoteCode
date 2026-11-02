import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import { safeEdit } from './projects.js';
import { getConfig } from '../../config/env.js';
import { getSetting, setSetting } from '../../database/client.js';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Settings screen.
 *
 * Auto-approval of dangerous tool calls is a real safety switch: it changes
 * whether OpenCode stops on a permission request. It is stored in the settings
 * table, and the effective value passed to the CLI is the OR of this switch and
 * the OPENCODE_ARGS coming from .env (which the operator controls).
 */
export function isAutoApproveEnabled(): boolean {
  return (getSetting('auto_approve') ?? 'off') === 'on';
}

/** Markdown rendering of assistant answers (see bot/api.ts). */
export function isMarkdownRepliesEnabled(): boolean {
  return (getSetting('markdown_replies') ?? 'on') === 'on';
}

export async function showSettings(ctx: Context): Promise<void> {
  const config = getConfig();

  const autoApprove = isAutoApproveEnabled();
  const envForcesAuto = config.opencodeArgs.includes('--auto');
  const markdown = isMarkdownRepliesEnabled();

  const lines = [
    '⚙️ <b>Настройки</b>',
    '',
    `Автосогласие опасных действий: <b>${autoApprove ? 'включено' : 'выключено'}</b>`,
    '',
    'Пока автосогласие выключено, OpenCode останавливается на запросе разрешения. ' +
      'RemoteCode покажет предупреждение, а решение примете вы явно.',
    envForcesAuto
      ? '⚠️ В .env задан <code>OPENCODE_ARGS=--auto</code> — автосогласие принудительно включено на уровне запуска CLI.'
      : '',
    '',
    `Ответы в формате Markdown: <b>${markdown ? 'включено' : 'выключено'}</b>`,
    markdown
      ? 'Ответы OpenCode отправляются с разметкой Telegram (жирный, курсив, блоки код). Если разметка в ответе сломана, сообщение уйдёт обычным текстом.'
      : 'Ответы OpenCode отправляются обычным текстом, без форматирования.',
    '',
    `Проектов: ${(await getContainer().projectManager.list()).length}`,
    `Активных процессов: ${getContainer().processManager.list().length}`,
    `Пользователей с доступом: ${config.authorizedUsers.length}`,
  ];

  const keyboard = new InlineKeyboard()
    .text(
      autoApprove ? '🚫 Выключить автосогласие' : '⚠️ Включить автосогласие',
      autoApprove ? CB.settingsAutoOff : CB.settingsAutoOn,
    )
    .row()
    .text(
      markdown ? '📝 Markdown-ответы: выключить' : '📝 Markdown-ответы: включить',
      markdown ? CB.settingsMdOff : CB.settingsMdOn,
    )
    .row()
    .text('🤖 Модели', CB.modelsList)
    .text('📊 Статус', CB.statusShow)
    .row()
    .text('⬅️ Меню', CB.navMain);

  const text = lines.filter(Boolean).join('\n');
  await safeEdit(ctx, text, CB.navMain);
  if (ctx.callbackQuery) {
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
  }
}

export async function setAutoApprove(ctx: Context, enabled: boolean): Promise<void> {
  setSetting('auto_approve', enabled ? 'on' : 'off');

  const text = enabled
    ? '⚠️ <b>Автосогласие включено</b>\n\n' +
      'OpenCode будет выполнять инструменты (запись файлов, выполнение команд) без дополнительных вопросов.\n\n' +
      'Используйте только в доверенных проектах.'
    : '✅ <b>Автосогласие выключено</b>\n\nОпасные действия теперь требуют явного подтверждения.';

  await safeEdit(ctx, text, CB.settingsMain);
  await showSettings(ctx);
}

/**
 * Toggles Markdown rendering of assistant answers. Off = plain text, which
 * can never fail to parse; on = legacy Markdown with a plain-text fallback
 * (see bot/api.ts), so a malformed model answer is still delivered.
 */
export async function setMarkdownReplies(ctx: Context, enabled: boolean): Promise<void> {
  setSetting('markdown_replies', enabled ? 'on' : 'off');

  const text = enabled
    ? '📝 <b>Markdown-ответы включены</b>\n\n' +
      'Ответы OpenCode будут отправляться с разметкой Telegram: жирный, курсив, <code>код</code> и блоки кода.\n\n' +
      'Если разметка в ответе окажется сломанной, сообщение автоматически уйдёт обычным текстом — ответ не потеряется.'
    : '📝 <b>Markdown-ответы выключены</b>\n\nОтветы OpenCode теперь отправляются обычным текстом, без форматирования.';

  await safeEdit(ctx, text, CB.settingsMain);
  await showSettings(ctx);
}
