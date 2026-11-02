import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Database layer tests.
 *
 * `src/database/client.ts` opens the SQLite file at import time, so the
 * environment must be fully configured BEFORE the first dynamic import. A
 * throwaway directory keeps tests isolated from the real data/ folder.
 */

let workDir: string;
type Db = typeof import('../src/database/client.js');

let client: Db;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'remotecode-dbtest-'));
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.AUTHORIZED_USERS = '1001, 1002';
  process.env.DATABASE_URL = path.join(workDir, 'test.db');
  process.env.PROJECTS_ROOT = path.join(workDir, 'projects');
  process.env.LOG_LEVEL = 'silent';

  client = await import('../src/database/client.js');
  client.initDatabase();
});

afterAll(() => {
  try {
    client?.closeDatabase();
  } catch {
    /* already closed */
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('schema', () => {
  it('creates the database file', () => {
    expect(existsSync(path.join(workDir, 'test.db'))).toBe(true);
  });

  it('initDatabase is idempotent', () => {
    expect(() => client.initDatabase()).not.toThrow();
    expect(() => client.initDatabase()).not.toThrow();
  });
});

describe('users', () => {
  it('records a user and reports authorization from config', () => {
    const user = client.upsertUser(1001);
    expect(user.telegramId).toBe(1001);
    expect(client.isAuthorized(1001)).toBe(true);
    // Config list is the source of truth, not the table.
    expect(client.isAuthorized(9999)).toBe(false);
  });

  it('is idempotent for the same telegram id', () => {
    const first = client.upsertUser(1002);
    const second = client.upsertUser(1002);
    expect(second.id).toBe(first.id);
  });
});

describe('projects', () => {
  it('creates and reads a project', () => {
    const project = client.createProject({ name: 'NeedRP', path: path.join(workDir, 'NeedRP') });
    expect(project.name).toBe('NeedRP');
    expect(client.getProject(project.id)?.name).toBe('NeedRP');
    expect(client.getProjectByPath(project.path)?.id).toBe(project.id);
  });

  it('rejects a duplicate path', () => {
    const existing = client.listProjects()[0];
    expect(existing).toBeDefined();
    expect(() => client.createProject({ name: 'Other', path: existing!.path })).toThrow();
  });

  it('lists projects', () => {
    expect(client.listProjects().length).toBeGreaterThanOrEqual(1);
  });
});

describe('sessions', () => {
  let projectId: string;

  beforeAll(() => {
    projectId = client.listProjects()[0]!.id;
  });

  it('creates a session with a null opencode id until OpenCode answers', () => {
    const session = client.createSession({ projectId, name: 'Авторизация', model: null });
    expect(session.opencodeSessionId).toBeNull();
    expect(session.status).toBe('idle');
  });

  it('persists the native OpenCode session id', () => {
    const session = client.createSession({ projectId, name: 'Система автомобилей', model: null });
    client.setOpencodeSessionId(session.id, 'ses_abc123');
    expect(client.getSession(session.id)?.opencodeSessionId).toBe('ses_abc123');
    expect(client.getSessionByOpencodeId('ses_abc123')?.id).toBe(session.id);
  });

  it('renames, retargets the model and touches the timestamp', () => {
    const session = client.createSession({ projectId, name: 'Старое имя', model: null });
    client.renameSession(session.id, 'Новое имя');
    client.updateSessionModel(session.id, 'opencode/mimo-v2.6-flash-free');
    client.updateSessionStatus(session.id, 'running');

    const updated = client.getSession(session.id)!;
    expect(updated.name).toBe('Новое имя');
    expect(updated.model).toBe('opencode/mimo-v2.6-flash-free');
    expect(updated.status).toBe('running');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
  });

  it('counts sessions per project', () => {
    expect(client.countSessions(projectId)).toBe(3);
  });

  it('deletes sessions belonging to a project', () => {
    const before = client.countSessions(projectId);
    for (const row of client.listSessions(projectId)) client.deleteSession(row.id);
    expect(client.countSessions(projectId)).toBe(0);
    expect(before).toBeGreaterThan(0);
  });
});

describe('messages', () => {
  let sessionId: string;

  beforeAll(() => {
    const projectId = client.listProjects()[0]!.id;
    sessionId = client.createSession({ projectId, name: 'История', model: null }).id;
  });

  it('stores messages in insertion order and respects the limit', () => {
    for (let i = 0; i < 12; i += 1) {
      client.addMessage({ sessionId, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` });
    }
    const all = client.listMessages(sessionId, 100);
    expect(all).toHaveLength(12);
    expect(all[0]!.content).toBe('msg 0');

    const limited = client.listMessages(sessionId, 5);
    expect(limited).toHaveLength(5);
    // The limit keeps the NEWEST messages.
    expect(limited[limited.length - 1]!.content).toBe('msg 11');
    expect(client.countMessages(sessionId)).toBe(12);
  });

  it('cascades deletion from the session', () => {
    client.deleteSession(sessionId);
    expect(client.listMessages(sessionId)).toHaveLength(0);
  });
});

describe('settings', () => {
  it('round-trips a value', () => {
    expect(client.getSetting('auto_approve')).toBeUndefined();
    client.setSetting('auto_approve', 'on');
    expect(client.getSetting('auto_approve')).toBe('on');
    client.setSetting('auto_approve', 'off');
    expect(client.getSetting('auto_approve')).toBe('off');
  });

  it('overwrites existing keys', () => {
    client.setSetting('k', 'a');
    client.setSetting('k', 'b');
    expect(client.getSetting('k')).toBe('b');
    expect(client.getAllSettings().k).toBe('b');
  });
});

describe('project cascade', () => {
  it('removes sessions when the project is deleted', () => {
    const project = client.createProject({ name: 'Cascade', path: path.join(workDir, 'Cascade') });
    client.createSession({ projectId: project.id, name: 's1', model: null });
    client.createSession({ projectId: project.id, name: 's2', model: null });
    expect(client.countSessions(project.id)).toBe(2);

    client.deleteProject(project.id);
    expect(client.getProject(project.id)).toBeUndefined();
    expect(client.countSessions(project.id)).toBe(0);
  });
});
