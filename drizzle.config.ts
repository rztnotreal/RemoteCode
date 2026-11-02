import type { Config } from 'drizzle-kit';

/**
 * Drizzle-kit config.
 *
 * Runtime migrations are applied by `initDatabase()` in src/database/client.ts
 * using idempotent `CREATE ... IF NOT EXISTS` statements, so the app works
 * without a migration runner. This config exists for development: use
 * `npx drizzle-kit generate` / `drizzle-kit push` when evolving the schema.
 */
export default {
  schema: './src/database/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? './data/remotecode.db',
  },
  strict: true,
  verbose: true,
} satisfies Config;
