/**
 * SQLite database access layer for RemoteCode.
 *
 * The database file is created (together with its parent directory) as soon
 * as this module is imported. `initDatabase()` applies the idempotent schema
 * so it is safe to call on every boot. All queries in the app go through the
 * typed repository functions below — nothing else should issue raw SQL.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { count, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { loadConfig } from '../config/env.js';
import type { ChatMessage, SessionStatus } from '../types.js';
import { newId, now } from '../utils/ids.js';
import { messages, projects, sessions, settings, users } from './schema.js';
import type { MessageRow, ProjectRow, SessionRow, SettingRow, UserRow } from './schema.js';

const config = loadConfig();

mkdirSync(path.dirname(config.databaseUrl), { recursive: true });

/** The raw better-sqlite3 handle (used for pragmas and shutdown). */
export const rawDb = new Database(config.databaseUrl);
rawDb.pragma('journal_mode = WAL');
rawDb.pragma('foreign_keys = ON');

/** Drizzle instance bound to the raw handle. */
export const db: BetterSQLite3Database = drizzle(rawDb);

/**
 * Creates the schema if it does not exist yet. Mirrors
 * src/database/schema.ts exactly (columns, defaults, foreign keys,
 * unique constraints and indexes) and is safe to run on every boot.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "telegram_id" integer NOT NULL,
  "created_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_telegram_id_unique" ON "users" ("telegram_id");
CREATE INDEX IF NOT EXISTS "users_telegram_id_idx" ON "users" ("telegram_id");

CREATE TABLE IF NOT EXISTS "projects" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "path" text NOT NULL,
  "created_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "projects_path_unique" ON "projects" ("path");
CREATE INDEX IF NOT EXISTS "projects_path_idx" ON "projects" ("path");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "opencode_session_id" text,
  "name" text NOT NULL,
  "model" text,
  "status" text NOT NULL DEFAULT 'idle',
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  CONSTRAINT "sessions_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "sessions_project_id_idx" ON "sessions" ("project_id");
CREATE INDEX IF NOT EXISTS "sessions_opencode_session_id_idx" ON "sessions" ("opencode_session_id");

CREATE TABLE IF NOT EXISTS "messages" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "created_at" integer NOT NULL,
  CONSTRAINT "messages_session_id_sessions_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "messages_session_id_idx" ON "messages" ("session_id");

CREATE TABLE IF NOT EXISTS "settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL
);
`;

/** Opens the schema (idempotent). Call once during startup. */
export function initDatabase(): void {
  rawDb.pragma('foreign_keys = ON');
  rawDb.exec(SCHEMA_SQL);
}

// Apply the schema eagerly so the repositories are usable as soon as this
// module is imported; calling initDatabase() again later stays harmless.
initDatabase();

/** Closes the underlying database handle. Safe to call more than once. */
export function closeDatabase(): void {
  if (rawDb.open) {
    rawDb.close();
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Inserts the user on first sight and returns the stored row. */
export function upsertUser(telegramId: number): UserRow {
  const existing = db.select().from(users).where(eq(users.telegramId, telegramId)).get();
  if (existing !== undefined) {
    return existing;
  }
  const row: UserRow = { id: newId('usr'), telegramId, createdAt: now() };
  db.insert(users).values(row).run();
  return row;
}

/**
 * Records the user (for audit purposes) and returns true when the Telegram id
 * is present in the configured AUTHORIZED_USERS list.
 */
export function isAuthorized(telegramId: number): boolean {
  upsertUser(telegramId);
  return config.authorizedUsers.includes(telegramId);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function createProject(input: { name: string; path: string }): ProjectRow {
  const row: ProjectRow = { id: newId('prj'), name: input.name, path: input.path, createdAt: now() };
  db.insert(projects).values(row).run();
  return row;
}

export function listProjects(): ProjectRow[] {
  return db.select().from(projects).orderBy(projects.createdAt).all();
}

export function getProject(id: string): ProjectRow | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function getProjectByPath(projectPath: string): ProjectRow | undefined {
  return db.select().from(projects).where(eq(projects.path, projectPath)).get();
}

/** Deletes a project; sessions and messages cascade via foreign keys. */
export function deleteProject(id: string): void {
  db.delete(projects).where(eq(projects.id, id)).run();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(input: {
  projectId: string;
  name: string;
  model: string | null;
  opencodeSessionId?: string | null;
}): SessionRow {
  const timestamp = now();
  const row: SessionRow = {
    id: newId('ses'),
    projectId: input.projectId,
    opencodeSessionId: input.opencodeSessionId ?? null,
    name: input.name,
    model: input.model,
    status: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(sessions).values(row).run();
  return row;
}

export function listSessions(projectId: string): SessionRow[] {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(desc(sessions.updatedAt))
    .all();
}

export function getSession(id: string): SessionRow | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export function getSessionByOpencodeId(opencodeSessionId: string): SessionRow | undefined {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.opencodeSessionId, opencodeSessionId))
    .get();
}

export function renameSession(id: string, name: string): void {
  db.update(sessions).set({ name, updatedAt: now() }).where(eq(sessions.id, id)).run();
}

export function updateSessionStatus(id: string, status: SessionStatus): void {
  db.update(sessions).set({ status, updatedAt: now() }).where(eq(sessions.id, id)).run();
}

export function updateSessionModel(id: string, model: string | null): void {
  db.update(sessions).set({ model, updatedAt: now() }).where(eq(sessions.id, id)).run();
}

export function setOpencodeSessionId(id: string, opencodeSessionId: string | null): void {
  db.update(sessions)
    .set({ opencodeSessionId, updatedAt: now() })
    .where(eq(sessions.id, id))
    .run();
}

/** Bumps `updated_at` without changing anything else (activity ping). */
export function touchSession(id: string): void {
  db.update(sessions).set({ updatedAt: now() }).where(eq(sessions.id, id)).run();
}

/** Deletes a session; its messages cascade via foreign keys. */
export function deleteSession(id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function countSessions(projectId: string): number {
  const row = db
    .select({ total: count() })
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .get();
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function addMessage(input: {
  sessionId: string;
  role: ChatMessage['role'];
  content: string;
}): MessageRow {
  const row: MessageRow = {
    id: newId('msg'),
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    createdAt: now(),
  };
  db.insert(messages).values(row).run();
  return row;
}

/**
 * Returns up to `limit` messages, oldest first (the most recent `limit`).
 *
 * Ordering uses SQLite's implicit `rowid`, which grows monotonically with
 * every insert. Message timestamps have millisecond resolution, so several
 * rows routinely share `created_at`; ordering by time alone (or by the random
 * uuid primary key) would shuffle a transcript. `rowid` is insertion order —
 * exactly what the history view must show.
 */
export function listMessages(sessionId: string, limit = 100): MessageRow[] {
  const recent = db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(sql`rowid desc`)
    .limit(limit)
    .all();
  return recent.reverse();
}

export function countMessages(sessionId: string): number {
  const row = db
    .select({ total: count() })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .get();
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSetting(key: string): string | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function getAllSettings(): Record<string, string> {
  const result: Record<string, string> = {};
  const rows: SettingRow[] = db.select().from(settings).all();
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
