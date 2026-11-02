import { InlineKeyboard } from 'grammy';
import { CB } from './index.js';

/**
 * Terminal Mode keyboard.
 *
 * Only a curated set of keys is exposed: RemoteCode must never degrade into a
 * general purpose shell for the requester. Free text goes through an explicit
 * "send line" flow rather than raw keystroke injection.
 */
export function terminalKeyboard(page: number, pages: number, running: boolean): InlineKeyboard {
  const k = new InlineKeyboard();

  if (!running) {
    return k
      .text('▶️ Запустить терминал', 'term:launch')
      .row()
      .text('💬 Chat Mode', CB.navMain);
  }

  k.text('⬆️', CB.termKey('up'))
    .text('⬇️', CB.termKey('down'))
    .text('⬅️', CB.termKey('left'))
    .text('➡️', CB.termKey('right'))
    .row();
  k.text('PgUp', CB.termKey('pageup'))
    .text('PgDn', CB.termKey('pagedown'))
    .text('Home', CB.termKey('home'))
    .text('End', CB.termKey('end'))
    .row();
  k.text('⏎ Ввод', CB.termKey('enter'))
    .text('⌫ Backspace', CB.termKey('backspace'))
    .text('ESC', CB.termKey('escape'))
    .row();
  k.text('Ctrl+C', CB.termKey('ctrlc'))
    .text('Ctrl+D', CB.termKey('ctrld'))
    .text('⛔ Закрыть', 'term:close')
    .row();

  if (pages > 1) {
    if (page > 0) k.text('📜 Выше', CB.termPage(page - 1));
    if (page < pages - 1) k.text('📜 Ниже', CB.termPage(page + 1));
    k.row();
  }

  k.text('✍️ Ввести строку', CB.termInput).text('🔄 Обновить', CB.termShow).row();
  k.text('💬 Chat Mode', CB.navMain);
  return k;
}
