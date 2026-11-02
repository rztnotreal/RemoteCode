/**
 * Environment configuration for RemoteCode.
 *
 * dotenv is loaded first, then the *whole* environment is validated with a
 * single Zod schema so that every misconfiguration is reported at once as one
 * aggregated error. The Telegram bot token is never included in error output.
 */

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

// `quiet` is only understood by newer dotenv versions; older typings would
// reject the property, hence the narrow cast.
loadDotenv({ quiet: true } as Parameters<typeof loadDotenv>[0]);

/**
 * Log levels accepted by LOG_LEVEL (superset of pino's own level names).
 * `silent` is included because pino accepts it and it is convenient for tests.
 */
const LOG_LEVELS = ['all', 'trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal', 'silent', 'none'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Fully validated, immutable application configuration. */
export interface Config {
  telegramBotToken: string;
  authorizedUsers: number[];
  opencodeBinary: string;
  opencodeArgs: string[];
  projectsRoot: string;
  databaseUrl: string;
  logLevel: LogLevel;
}

/**
 * Splits a shell-like argument string into tokens.
 *
 * Respects double quotes, single quotes and backslash escapes outside of
 * single quotes. Throws on unterminated quotes so misconfiguration fails fast.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charAt(i);

    if (quote === "'") {
      // Single quotes are literal until the closing quote.
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\') {
        const next = input.charAt(i + 1);
        current += next === '' ? ch : next;
        if (next !== '') i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    // Unquoted.
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === '\\') {
      const next = input.charAt(i + 1);
      if (next === '') {
        current += ch;
      } else {
        current += next;
        i += 1;
      }
      hasToken = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (quote !== null) {
    throw new Error(`unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Parses a comma/whitespace separated list of Telegram user IDs.
 * Numbers may be wrapped in single or double quotes.
 */
function parseAuthorizedUsers(raw: string): Parsed<number[]> {
  const ids: number[] = [];
  const invalid: string[] = [];

  for (const token of raw.split(/[\s,]+/)) {
    if (token === '') continue;
    const unquoted =
      token.length >= 2 &&
      ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
        ? token.slice(1, -1)
        : token;
    if (!/^-?\d+$/.test(unquoted)) {
      invalid.push(token);
      continue;
    }
    const id = Number(unquoted);
    if (!Number.isSafeInteger(id)) {
      invalid.push(token);
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }

  if (invalid.length > 0) {
    return { ok: false, message: `must contain only Telegram user IDs, got invalid value(s): ${invalid.join(', ')}` };
  }
  if (ids.length === 0) {
    return { ok: false, message: 'must contain at least one comma-separated Telegram user ID' };
  }
  return { ok: true, value: ids };
}

/** Treats missing or blank values as unset so defaults apply. */
function orDefault(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .min(1, 'is required and must be a non-empty string'),
  AUTHORIZED_USERS: z.string().transform((raw, ctx) => {
    const parsed = parseAuthorizedUsers(raw);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.message });
      return [];
    }
    return parsed.value;
  }),
  OPENCODE_BINARY: z.string().optional().transform((value) => orDefault(value, 'opencode')),
  OPENCODE_ARGS: z.string().optional().transform((value, ctx) => {
    try {
      return splitArgs(orDefault(value, '--auto'));
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `is invalid: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }
  }),
  PROJECTS_ROOT: z
    .string()
    .optional()
    .transform((value) => path.resolve(orDefault(value, './projects'))),
  DATABASE_URL: z
    .string()
    .optional()
    .transform((value) => path.resolve(orDefault(value, './data/remotecode.db'))),
  LOG_LEVEL: z
    .enum(LOG_LEVELS)
    .optional()
    .transform((value) => value ?? 'info'),
});

type EnvData = z.infer<typeof envSchema>;

function buildConfig(data: EnvData): Config {
  return Object.freeze({
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    authorizedUsers: Object.freeze([...data.AUTHORIZED_USERS]) as number[],
    opencodeBinary: data.OPENCODE_BINARY,
    opencodeArgs: Object.freeze([...data.OPENCODE_ARGS]) as string[],
    projectsRoot: data.PROJECTS_ROOT,
    databaseUrl: data.DATABASE_URL,
    logLevel: data.LOG_LEVEL,
  });
}

let cached: Config | undefined;

/**
 * Validates the environment and returns the frozen config.
 * The result is cached; subsequent calls return the same object.
 * Throws a single aggregated error listing every problem found.
 */
export function loadConfig(): Config {
  if (cached !== undefined) return cached;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join('.') : '(environment)';
      return `  - ${key} ${issue.message}`;
    });
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  cached = buildConfig(result.data);
  return cached;
}

/** Returns the already-loaded config, or throws a helpful error. */
export function getConfig(): Config {
  if (cached === undefined) {
    throw new Error('Configuration has not been loaded yet. Call loadConfig() before getConfig().');
  }
  return cached;
}
