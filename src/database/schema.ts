import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema for RemoteCode.
 *
 * All timestamps are stored as unix epoch milliseconds (integer).
 * All ids are application-generated strings (`crypto.randomUUID()` or
 * `ses_...` style OpenCode ids) so that rows can be created offline.
 */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    telegramId: integer('telegram_id').notNull().unique(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('users_telegram_id_idx').on(t.telegramId)],
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull().unique(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('projects_path_idx').on(t.path)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    opencodeSessionId: text('opencode_session_id'),
    name: text('name').notNull(),
    model: text('model'),
    status: text('status').notNull().default('idle'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('sessions_project_id_idx').on(t.projectId),
    index('sessions_opencode_session_id_idx').on(t.opencodeSessionId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_session_id_idx').on(t.sessionId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
