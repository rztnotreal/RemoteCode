import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `rc-smoke-${Date.now()}.db`);

process.env.TELEGRAM_BOT_TOKEN = 'SECRET_TOKEN_VALUE';
process.env.AUTHORIZED_USERS = '"111", 222\n333';
delete process.env.OPENCODE_BINARY;
delete process.env.OPENCODE_ARGS;
delete process.env.PROJECTS_ROOT;
delete process.env.LOG_LEVEL;
process.env.DATABASE_URL = dbPath;

describe('env smoke', () => {
  it('loads config with defaults and parsed ids', async () => {
    const { loadConfig, getConfig, splitArgs } = await import('../src/config/env.js');
    const cfg = loadConfig();
    expect(cfg.telegramBotToken).toBe('SECRET_TOKEN_VALUE');
    expect(cfg.authorizedUsers).toEqual([111, 222, 333]);
    expect(cfg.opencodeBinary).toBe('opencode');
    expect(cfg.opencodeArgs).toEqual(['--auto']);
    expect(cfg.projectsRoot).toBe(path.resolve('./projects'));
    expect(cfg.databaseUrl).toBe(dbPath);
    expect(cfg.logLevel).toBe('info');
    expect(getConfig()).toBe(cfg);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(splitArgs(`--flag "a b" 'c d' e\\ f`)).toEqual(['--flag', 'a b', 'c d', 'e f']);
    expect(() => splitArgs('"unterminated')).toThrow(/unterminated/);
  });

  it('aggregates errors without leaking the token', async () => {
    vi.resetModules();
    process.env.AUTHORIZED_USERS = 'abc';
    process.env.LOG_LEVEL = 'bogus';
    const { loadConfig } = await import('../src/config/env.js');
    let message = '';
    try {
      loadConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Invalid environment configuration');
    expect(message).toContain('AUTHORIZED_USERS');
    expect(message).toContain('LOG_LEVEL');
    expect(message).not.toContain('SECRET_TOKEN_VALUE');
    vi.resetModules();
    process.env.AUTHORIZED_USERS = '"111", 222';
    process.env.LOG_LEVEL = 'info';
  });
});

describe('logger smoke', () => {
  it('creates a root and child logger', async () => {
    const { logger, createLogger } = await import('../src/utils/logger.js');
    const child = createLogger('smoke');
    expect(typeof logger.info).toBe('function');
    expect(child.bindings()).toMatchObject({ module: 'smoke' });
    logger.info({ telegramBotToken: 'SECRET' }, 'redaction check');
  });
});

describe('database smoke', () => {
  it('runs the full repository layer', async () => {
    const client = await import('../src/database/client.js');
    client.initDatabase();

    const user = client.upsertUser(111);
    expect(user.telegramId).toBe(111);
    expect(client.upsertUser(111).id).toBe(user.id);
    expect(client.isAuthorized(111)).toBe(true);
    expect(client.isAuthorized(999)).toBe(false);

    const project = client.createProject({ name: 'demo', path: '/tmp/demo' });
    expect(client.getProject(project.id)?.name).toBe('demo');
    expect(client.getProjectByPath('/tmp/demo')?.id).toBe(project.id);
    expect(client.listProjects()).toHaveLength(1);

    const session = client.createSession({ projectId: project.id, name: 's1', model: null });
    expect(session.status).toBe('idle');
    expect(client.countSessions(project.id)).toBe(1);

    client.renameSession(session.id, 'renamed');
    client.updateSessionStatus(session.id, 'running');
    client.updateSessionModel(session.id, 'anthropic/claude');
    client.setOpencodeSessionId(session.id, 'ses_abc');
    client.touchSession(session.id);
    const reloaded = client.getSession(session.id);
    expect(reloaded?.name).toBe('renamed');
    expect(reloaded?.status).toBe('running');
    expect(reloaded?.model).toBe('anthropic/claude');
    expect(client.getSessionByOpencodeId('ses_abc')?.id).toBe(session.id);

    for (let i = 0; i < 5; i += 1) {
      client.addMessage({ sessionId: session.id, role: 'user', content: `msg ${i}` });
    }
    expect(client.countMessages(session.id)).toBe(5);
    const recent = client.listMessages(session.id, 3);
    expect(recent).toHaveLength(3);
    expect(recent.map((m) => m.content)).toEqual(['msg 2', 'msg 3', 'msg 4']);

    client.setSetting('k', 'v1');
    client.setSetting('k', 'v2');
    client.setSetting('k2', 'x');
    expect(client.getSetting('k')).toBe('v2');
    expect(client.getAllSettings()).toEqual({ k: 'v2', k2: 'x' });

    client.deleteSession(session.id);
    expect(client.countSessions(project.id)).toBe(0);
    expect(client.countMessages(session.id)).toBe(0);

    client.deleteProject(project.id);
    expect(client.listProjects()).toHaveLength(0);

    client.closeDatabase();
    client.closeDatabase(); // idempotent
  });
});
