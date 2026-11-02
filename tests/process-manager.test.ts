import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProcessManager } from '../src/cli/process-manager.js';
import { OpenCodeAdapter } from '../src/cli/opencode-adapter.js';
import type { RunProgress, Session } from '../src/types.js';
import {
  closeDatabase,
  createProject,
  createSession,
  getSession,
  listMessages,
} from '../src/database/client.js';
import type { ProjectRow } from '../src/database/schema.js';

/**
 * ProcessManager tests: per-session FIFO, cross-session isolation, cancel,
 * queue flush, shutdown and DB persistence — all against REAL fixture child
 * processes (node speaking the `opencode run --format json` protocol).
 *
 * The SQLite database comes from the environment prepared in setup-env.ts, so
 * persistence assertions hit the same repository layer the bot uses.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Lets per-session queue bookkeeping settle after `handle.done` resolves. */
function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let project: ProjectRow;
let seq = 0;

/** A brand-new session so each test starts with clean state. */
function newSession(name: string): Session {
  seq += 1;
  return createSession({
    projectId: project.id,
    name: `${name}-${seq}`,
    model: null,
    opencodeSessionId: null,
  }) as unknown as Session;
}

/** A manager whose CLI is the given fixture script run by node. */
function makeManager(fixtureName: string, argv: string[] = []): ProcessManager {
  return new ProcessManager({
    adapter: new OpenCodeAdapter({
      binary: process.execPath,
      argvOverride: [path.join(here, 'fixtures', fixtureName), ...argv],
    }),
  });
}

function send(
  pm: ProcessManager,
  session: Session,
  message: string,
  extra: Partial<Parameters<ProcessManager['send']>[0]> = {},
): ReturnType<ProcessManager['send']> {
  return pm.send({
    session,
    project,
    message,
    autoApprove: false,
    ...extra,
  });
}

beforeAll(() => {
  project = createProject({ name: 'pm-tests', path: os.tmpdir() });
});

afterAll(() => {
  closeDatabase();
});

describe('single run', () => {
  it('runs a prompt and persists session id, transcript and status', async () => {
    const pm = makeManager('ndjson-ok.cjs');
    const session = newSession('single');

    const progress: RunProgress[] = [];
    const handle = await send(pm, session, 'hello there', {
      onProgress: (p) => progress.push(p),
    });
    const result = await handle.done;

    expect(result.ok).toBe(true);
    expect(result.text).toContain('ECHO:hello there');
    expect(progress.length).toBeGreaterThan(0);

    // The native OpenCode session id was learned and stored for resume.
    const stored = getSession(session.id);
    expect(stored?.opencodeSessionId).toMatch(/^ses_fixture_/);
    expect(stored?.status).toBe('idle');

    // The transcript was persisted: the prompt and the answer.
    // (Same-millisecond rows have no deterministic order, so match by role.)
    const messages = listMessages(session.id, 10);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role).sort()).toEqual(['assistant', 'user']);
    expect(messages.find((m) => m.role === 'user')?.content).toBe('hello there');
    expect(messages.find((m) => m.role === 'assistant')?.content).toContain('ECHO:hello there');

    // Bookkeeping is released: nothing busy, nothing queued.
    // (`handle.done` resolves slightly before the queue drains its flag.)
    await settle();
    expect(pm.isBusy(session.id)).toBe(false);
    expect(pm.queueLength(session.id)).toBe(0);
    expect(pm.snapshot(session.id)?.status).toBe('idle');
  });

  it('surfaces a failed run as an error event and error status', async () => {
    const pm = makeManager('ndjson-fail.cjs');
    const session = newSession('fail');
    const errors: string[] = [];
    pm.on('error', (event) => errors.push(event.error));

    const handle = await send(pm, session, 'boom');
    const result = await handle.done;

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain('fixture failure');
    expect(errors).toHaveLength(1);
    expect(getSession(session.id)?.status).toBe('error');

    // The user prompt is kept even when the run failed.
    expect(listMessages(session.id, 10).map((m) => m.role)).toEqual(['user']);
  });
});

describe('FIFO queue inside one session', () => {
  it('runs queued prompts strictly one after another', async () => {
    const pm = makeManager('ndjson-slow.cjs', ['--delay=300']);
    const session = newSession('fifo');

    const events: string[] = [];
    pm.on('started', () => events.push('start'));
    pm.on('finished', () => events.push('finish'));

    // Queue three prompts at once (none awaited yet).
    const sends = [
      send(pm, session, 'first'),
      send(pm, session, 'second'),
      send(pm, session, 'third'),
    ];

    // The first run starts immediately; the other two must be waiting.
    const first = await sends[0]!;
    expect(pm.queueLength(session.id)).toBe(2);
    expect(pm.isBusy(session.id)).toBe(true);
    expect(events).toEqual(['start']);

    const [firstResult, secondHandle, thirdHandle] = [
      await first.done,
      await sends[1]!,
      await sends[2]!,
    ];
    const [secondResult, thirdResult] = await Promise.all([
      secondHandle.done,
      thirdHandle.done,
    ]);

    // Strict serialisation: start/finish/start/finish/start/finish — never two
    // runs overlapping inside the same session.
    expect(events).toEqual([
      'start', 'finish',
      'start', 'finish',
      'start', 'finish',
    ]);

    expect(firstResult.text).toContain('START:first');
    expect(secondResult.text).toContain('START:second');
    expect(thirdResult.text).toContain('START:third');

    // The in-memory buffer preserves the exact execution order: the three
    // prompts strictly in submission order, each reply right after its prompt.
    const buffer = pm.get(session.id)?.buffer ?? [];
    expect(buffer.filter((line) => line.role === 'user').map((line) => line.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(buffer.filter((line) => line.role === 'assistant').map((line) => line.text)).toEqual([
      'START:first\n\nEND',
      'START:second\n\nEND',
      'START:third\n\nEND',
    ]);

    // Every prompt and every reply made it into the database.
    const persisted = listMessages(session.id, 10);
    expect(persisted).toHaveLength(6);
    expect(persisted.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  }, 20_000);
});

describe('session isolation', () => {
  it('runs two sessions concurrently with separate state', async () => {
    const pm = makeManager('ndjson-slow.cjs', ['--delay=1000']);
    const sessionA = newSession('iso-a');
    const sessionB = newSession('iso-b');

    const startedAt: number[] = [];
    const finishedAt: number[] = [];
    pm.on('started', () => startedAt.push(Date.now()));
    pm.on('finished', () => finishedAt.push(Date.now()));

    const handleA = await send(pm, sessionA, 'task A');
    const handleB = await send(pm, sessionB, 'task B');

    // Both runs are live at the same time (B started long before A finished).
    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]! - startedAt[0]!).toBeLessThan(1000);
    expect(finishedAt).toHaveLength(0);

    const [resultA, resultB] = await Promise.all([handleA.done, handleB.done]);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(resultA.text).toContain('START:task A');
    expect(resultB.text).toContain('START:task B');

    // Each session got its own native session id — no cross-contamination.
    const storedA = getSession(sessionA.id)?.opencodeSessionId;
    const storedB = getSession(sessionB.id)?.opencodeSessionId;
    expect(storedA).toMatch(/^ses_slow_/);
    expect(storedB).toMatch(/^ses_slow_/);
    expect(storedA).not.toBe(storedB);
  }, 20_000);
});

describe('cancellation', () => {
  it('aborts the running prompt and reports it as cancelled', async () => {
    const pm = makeManager('ndjson-slow.cjs', ['--delay=60000']);
    const session = newSession('cancel');
    const reasons: string[] = [];
    pm.on('cancelled', (event) => reasons.push(event.reason));

    const handle = await send(pm, session, 'very long task');
    const stopped = await pm.cancel(session.id, 'user_stop');

    expect(stopped).toBe(true);
    const result = await handle.done;

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('user_stop');
    expect(reasons).toContain('user_stop');
    expect(result.text).not.toContain('END'); // the60s fixture never completed

    // A cancelled run leaves the session usable (idle), not wedged.
    // (Small delay: the queue's `running` flag drops just after `done`.)
    await settle();
    expect(pm.isBusy(session.id)).toBe(false);
    expect(getSession(session.id)?.status).toBe('idle');

    expect(await pm.cancel(session.id)).toBe(false); // cancelling again: no-op
  }, 20_000);

  it('flushQueue drops waiting prompts and rejects their start', async () => {
    const pm = makeManager('ndjson-slow.cjs', ['--delay=500']);
    const session = newSession('flush');

    const handle = await send(pm, session, 'survivor');
    const queued1 = send(pm, session, 'dropped-1');
    const queued2 = send(pm, session, 'dropped-2');
    expect(pm.queueLength(session.id)).toBe(2);

    expect(pm.flushQueue(session.id)).toBe(2);
    expect(pm.queueLength(session.id)).toBe(0);

    await expect(queued1).rejects.toThrow(/очередь сообщений сессии очищена/u);
    await expect(queued2).rejects.toThrow(/очередь сообщений сессии очищена/u);

    // The already-running prompt is untouched by the flush.
    const result = await handle.done;
    expect(result.ok).toBe(true);
    expect(result.text).toContain('START:survivor');
    expect(pm.flushQueue(session.id)).toBe(0); // nothing left to drop
  }, 20_000);
});

describe('shutdown', () => {
  it('aborts live runs, rejects queued ones and refuses new work', async () => {
    const pm = makeManager('ndjson-slow.cjs', ['--delay=60000']);
    const session = newSession('shutdown');

    const handle = await send(pm, session, 'in flight');
    const queued = send(pm, session, 'never runs');
    // Attach the rejection expectation BEFORE shutdown so the deliberate
    // rejection inside it is never reported as an unhandled rejection.
    const queuedRejected = expect(queued).rejects.toThrow(/shutting down/u);

    await pm.shutdown(5_000);

    const result = await handle.done;
    expect(result.cancelled).toBe(true);
    await queuedRejected;
    await expect(send(pm, session, 'after shutdown')).rejects.toThrow(/shutting down/u);

    // All state is gone — no processes, no queues, no listeners.
    expect(pm.list()).toHaveLength(0);
    expect(pm.isBusy(session.id)).toBe(false);
    // Idempotent.
    await pm.shutdown(1_000);
  }, 20_000);
});
