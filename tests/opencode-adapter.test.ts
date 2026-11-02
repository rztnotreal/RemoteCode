import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenCodeAdapter } from '../src/cli/opencode-adapter.js';
import type { RunProgress, RunResult } from '../src/types.js';

/**
 * Chat Mode adapter tests.
 *
 * Every case drives a REAL child process (node running a fixture script that
 * speaks the same NDJSON protocol as `opencode run --format json`), so the
 * whole path — argv construction, spawn without a shell, streaming NDJSON
 * parser, completion-by-exit-code, cancellation and the hang guard — is
 * exercised end to end without touching the network or spending model credits.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = os.tmpdir();

/** Builds an adapter whose "CLI" is the given fixture script run by node. */
function adapterFor(fixtureName: string, argv: string[] = []): OpenCodeAdapter {
  return new OpenCodeAdapter({
    binary: process.execPath,
    argvOverride: [path.join(here, 'fixtures', fixtureName), ...argv],
  });
}

/** Drains streamRun() collecting both the progress events and the result. */
async function drain(
  adapter: OpenCodeAdapter,
  options: Parameters<OpenCodeAdapter['run']>[0],
): Promise<{ progress: RunProgress[]; result: RunResult }> {
  const progress: RunProgress[] = [];
  const iterator = adapter.streamRun(options);
  let step = await iterator.next();
  while (step.done !== true) {
    progress.push(step.value);
    step = await iterator.next();
  }
  return { progress, result: step.value };
}

describe('successful run', () => {
  it('parses NDJSON events, tools, text and the session id', async () => {
    const adapter = adapterFor('ndjson-ok.cjs');
    const { progress, result } = await drain(adapter, { cwd, message: 'hello world' });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.error).toBeNull();

    // The prompt survived as ONE argv element and came back in the answer.
    expect(result.text).toContain('ECHO:hello world');
    expect(result.text).toContain('MODEL:default');
    expect(result.text).toContain('AUTO:no');

    // Tool invocations are collected, text parts joined in order.
    expect(result.tools).toEqual(['write src/index.ts']);
    expect(result.text.indexOf('ECHO:')).toBeLessThan(result.text.indexOf('MODEL:'));

    // The native session id was learned from the event stream.
    expect(result.opencodeSessionId).toMatch(/^ses_fixture_/);

    // Live progress: session id, tool label, text and the child pid status.
    expect(progress.some((p) => p.kind === 'session')).toBe(true);
    expect(progress.some((p) => p.kind === 'tool' && p.tool === 'write src/index.ts')).toBe(true);
    expect(progress.some((p) => p.kind === 'text')).toBe(true);
    expect(progress.some((p) => p.kind === 'status' && /pid=\d+/u.test(p.status ?? ''))).toBe(true);
  });

  it('keeps a multi-line prompt as a single prompt', async () => {
    const adapter = adapterFor('ndjson-ok.cjs');
    const result = await adapter.run({ cwd, message: 'line one\nline two\nline three' });

    expect(result.ok).toBe(true);
    // All three lines came back inside ONE echoed message (not three runs).
    expect(result.text).toContain('ECHO:line one\nline two\nline three');
  });

  it('never lets shell metacharacters change the command', async () => {
    const adapter = adapterFor('ndjson-ok.cjs');
    const payload = 'a "b" & | $HOME `id` <tag> ; rm -rf';
    const result = await adapter.run({ cwd, message: payload });

    expect(result.ok).toBe(true);
    // The exact text arrived — no shell expanded, quoted or dropped anything.
    expect(result.text).toContain(`ECHO:${payload}`);
  });

  it('resumes a session and passes model + --auto', async () => {
    const adapter = adapterFor('ndjson-ok.cjs');
    const result = await adapter.run({
      cwd,
      message: 'continue please',
      sessionId: 'ses_known_session',
      model: 'anthropic/claude-sonnet-4',
      autoApprove: true,
    });

    expect(result.ok).toBe(true);
    expect(result.opencodeSessionId).toBe('ses_known_session');
    expect(result.text).toContain('MODEL:anthropic/claude-sonnet-4');
    expect(result.text).toContain('AUTO:yes');
  });

  it('flushes an NDJSON tail that has no trailing newline', async () => {
    const adapter = adapterFor('ndjson-tail.cjs');
    const result = await adapter.run({ cwd, message: 'tail prompt' });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('TAIL:tail prompt');
  });
});

describe('failures', () => {
  it('reports a non-zero exit code and the stderr tail', async () => {
    const adapter = adapterFor('ndjson-fail.cjs');
    const result = await adapter.run({ cwd, message: 'anything' });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.cancelled).toBe(false);
    expect(result.error).toContain('fixture failure');
  });

  it('refuses an empty prompt without spawning anything', async () => {
    const adapter = adapterFor('ndjson-ok.cjs');
    const { progress, result } = await drain(adapter, { cwd, message: '   ' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('message must not be empty');
    expect(result.text).toBe('');
    // The only event is the refusal notice — no child was ever started.
    expect(progress).toHaveLength(1);
    expect(progress[0]?.kind).toBe('status');
  });

  it('reports an already-aborted signal without starting a run', async () => {
    const adapter = adapterFor('ndjson-ok.cjs');
    const controller = new AbortController();
    controller.abort('stop before start');

    const result = await adapter.run({ cwd, message: 'x', signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('stop before start');
  });
});

describe('cancellation and hang guard', () => {
  it('kills the child when the signal aborts mid-run', async () => {
    const adapter = adapterFor('ndjson-slow.cjs', ['--delay=60000']);
    const controller = new AbortController();

    const iterator = adapter.streamRun({ cwd, message: 'slow', signal: controller.signal });
    let step = await iterator.next();
    while (step.done !== true) {
      if (step.value.kind === 'text') controller.abort('user pressed stop');
      step = await iterator.next();
    }
    const result = step.value;

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('user pressed stop');
    // The60s fixture never finished on its own: the run ended because of us.
    expect(result.text).not.toContain('END');
  });

  it('kills a silent run after the hang-guard timeout', async () => {
    const adapter = adapterFor('ndjson-slow.cjs', ['--delay=60000']);
    const started = Date.now();
    const { progress, result } = await drain(adapter, {
      cwd,
      message: 'slow',
      timeoutMs: 400,
    });

    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(false); // a hang is an error, not a user cancel
    expect(result.error).toMatch(/no output for 400ms/u);
    expect(Date.now() - started).toBeLessThan(10_000); // killed, not waited out
    expect(progress.some((p) => p.kind === 'status' && /hang guard/u.test(p.status ?? ''))).toBe(true);
  }, 15_000);
});
