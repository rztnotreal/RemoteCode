/**
 * Environment defaults for the unit test suite.
 *
 * Runs BEFORE any test module is imported, so modules that validate the
 * environment at import time (config → logger → database) always see a valid,
 * isolated configuration. Individual tests may still override these values —
 * they assign AFTER this file has run.
 *
 * Nothing here contains a real token: the suite never talks to Telegram.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN ??= '000000:TEST_TOKEN_NEVER_USED';
process.env.AUTHORIZED_USERS ??= '1001';
process.env.LOG_LEVEL ??= 'silent';
// A fresh database per test file keeps suites independent of each other.
process.env.DATABASE_URL = path.join(
  os.tmpdir(),
  `remotecode-test-${process.pid}-${randomUUID().slice(0, 8)}.db`,
);
