import { Bot } from 'grammy';
import { getConfig } from '../config/env.js';
import { authMiddleware } from './middleware/auth.js';
import { handleStart } from './commands/start.js';
import { handleCallback } from './handlers/callback.js';
import { handleText } from './handlers/text.js';
import { setBotApi } from './api.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bot');

/**
 * Wires the grammY bot.
 *
 * Only two update handlers exist on purpose: every callback action and every
 * text message is dispatched by our own routers, so the authorization
 * middleware is guaranteed to run in front of all of them.
 */
export function createBot(): Bot {
  const config = getConfig();
  const bot = new Bot(config.telegramBotToken);

  // Services render their own status cards through this handle.
  setBotApi(bot.api);

  bot.use(authMiddleware);

  bot.command('start', handleStart);
  bot.command('help', handleStart);

  bot.on('callback_query:data', handleCallback);
  bot.on('message:text', handleText);

  bot.catch((error) => {
    log.error(
      {
        err: error.error instanceof Error ? error.error.message : String(error.error),
        update: error.ctx.update.update_id,
      },
      'unhandled bot error',
    );
  });

  return bot;
}
