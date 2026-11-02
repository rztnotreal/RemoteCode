/**
 * Shared pino logger for RemoteCode.
 *
 * The root logger is built from the validated config. Outside production a
 * pino-pretty transport is used for readable single-line coloured output.
 * The Telegram bot token is redacted from every log record.
 */

import pino from 'pino';
import type { LevelWithSilent, Logger as PinoLogger } from 'pino';
import { loadConfig } from '../config/env.js';
import type { LogLevel } from '../config/env.js';

const config = loadConfig();

/** Maps our LOG_LEVEL vocabulary onto pino level names. */
const PINO_LEVELS: Record<string, LevelWithSilent> = {
  all: 'trace',
  warning: 'warn',
  none: 'silent',
};

function toPinoLevel(level: LogLevel): LevelWithSilent {
  return PINO_LEVELS[level] ?? (level as LevelWithSilent);
}

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: toPinoLevel(config.logLevel),
  redact: {
    paths: [
      'telegramBotToken',
      'config.telegramBotToken',
      '*.telegramBotToken',
      'TELEGRAM_BOT_TOKEN',
      'token',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
});

export type Logger = PinoLogger;

/** Creates a child logger tagged with the module name. */
export function createLogger(name: string): PinoLogger {
  return logger.child({ module: name });
}
