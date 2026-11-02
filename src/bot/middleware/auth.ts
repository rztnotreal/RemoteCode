import type { Context, NextFunction } from 'grammy';
import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config/env.js';

const log = createLogger('auth');

/**
 * Hard gate for every update.
 *
 * RemoteCode controls a real shell-level tool, so authorization is checked on
 * each and every action rather than once at /start. Unauthorized users get a
 * neutral refusal and are never shown project paths, session data or terminal
 * output.
 */
export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const config = getConfig();

  const userId = ctx.from?.id;
  if (userId === undefined) {
    // Channel posts / unknown senders carry no user — nothing to authorize.
    return;
  }

  if (!config.authorizedUsers.includes(userId)) {
    log.warn({ userId, username: ctx.from?.username }, 'rejected unauthorized user');

    const text =
      '⛔ <b>Доступ запрещён</b>\n\n' +
      'Этот Telegram ID не входит в список разрешённых.\n' +
      'Добавьте его в <code>AUTHORIZED_USERS</code> в файле .env и перезапустите бота.';

    // Never leak configuration details to the requester.
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Доступ запрещён' }).catch(() => undefined);
    }
    await ctx.reply(text, { parse_mode: 'HTML' }).catch(() => undefined);
    return;
  }

  await next();
}
