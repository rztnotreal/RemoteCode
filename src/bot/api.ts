import type { Api } from 'grammy';
// Telegram wire types are re-exported by grammy under the `/types` subpath.
import type { InlineKeyboardMarkup, MaybeInaccessibleMessage } from 'grammy/types';
import { getSetting } from '../database/client.js';

/**
 * Bot API handle shared with the service layer.
 *
 * TaskManager renders status cards and final answers but must stay free of any
 * grammy import (it is tested with a fake sink). The sink factory created at
 * boot therefore reaches the API through this module instead of threading a
 * `ctx` through every call.
 */
let api: Api | null = null;

export function setBotApi(next: Api): void {
  api = next;
}

export function getBotApi(): Api {
  if (!api) {
    throw new Error('Bot API is not initialised — setBotApi() must run during boot.');
  }
  return api;
}

export function hasBotApi(): boolean {
  return api !== null;
}

function markupOf(markup: unknown): InlineKeyboardMarkup | undefined {
  return (markup as InlineKeyboardMarkup | undefined) ?? undefined;
}

/**
 * Whether assistant answers are rendered with Telegram's legacy Markdown.
 *
 * Stored per user as `markdown_replies` (`on`/`off`, default ON — the user
 * explicitly asked for Markdown answers). Legacy `Markdown` (not `MarkdownV2`)
 * is used because model output contains raw `*`, `_` and backticks that
 * MarkdownV2 would reject; unmatched entities are handled by the plain-text
 * fallback below.
 */
export function markdownRepliesEnabled(): boolean {
  try {
    return (getSetting('markdown_replies') ?? 'on') === 'on';
  } catch {
    // Settings table unavailable (isolated tests): keep answers plain.
    return false;
  }
}

/** True when Telegram refused the text because of broken Markdown entities. */
function isParseError(error: unknown): boolean {
  const description = (error as { description?: unknown } | null)?.description;
  return typeof description === 'string' && description.includes('parse entities');
}

/**
 * Applies the Markdown parse mode when the user has it enabled.
 *
 * Returns the original options if Markdown is off or if Telegram rejects the
 * entities (a raw model answer must NEVER be lost to a formatting error — the
 * message is re-sent as plain text instead).
 */
async function withMarkdown<T>(
  run: (parseMode: 'Markdown' | undefined) => Promise<T>,
): Promise<T> {
  if (!markdownRepliesEnabled()) return run(undefined);
  try {
    return await run('Markdown');
  } catch (error) {
    if (!isParseError(error)) throw error;
    return run(undefined);
  }
}

/**
 * Builds a message sink bound to one status message.
 *
 * Formatting: assistant answers follow the «Markdown-ответы» setting. When the
 * setting is off (or Telegram cannot parse the entities) the text is sent
 * verbatim as plain text, so a long answer the user has been waiting for is
 * never mangled or lost.
 */
export function createBotSink(ref: { chatId: number; messageId: number }): {
  edit(text: string, markup?: unknown): Promise<void>;
  send(text: string, markup?: unknown): Promise<void>;
} {
  return {
    async edit(text: string, markup?: unknown): Promise<void> {
      await withMarkdown(async (parseMode) => {
        const target = await getBotApi().editMessageText(ref.chatId, ref.messageId, text, {
          reply_markup: markupOf(markup),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        });
        void target;
      });
    },
    async send(text: string, markup?: unknown): Promise<void> {
      await withMarkdown(async (parseMode) => {
        await getBotApi().sendMessage(ref.chatId, text, {
          reply_markup: markupOf(markup),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        });
      });
    },
  };
}

/** Type guard helper used when inspecting edited messages in tests. */
export function isAccessibleMessage(
  message: MaybeInaccessibleMessage,
): message is Exclude<MaybeInaccessibleMessage, { status: 'unaccessible' }> {
  return !('status' in message);
}
