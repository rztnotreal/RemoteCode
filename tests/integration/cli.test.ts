import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInvocation, runProcess } from '../../src/cli/process-runner.js';
import { ModelManager } from '../../src/cli/model-manager.js';
import { SessionManager } from '../../src/cli/session-manager.js';

/**
 * Integration tests against the REAL installed OpenCode CLI.
 *
 * They are opt-in (`npm run test:integration`) because they invoke the actual
 * binary; they deliberately avoid running prompts so no model credits are
 * spent — the full live prompt chain is covered by `npm run smoke`.
 *
 * Every test skips itself when the CLI cannot be resolved on this machine.
 */

function cliResolves(): boolean {
  try {
    resolveInvocation(process.env.OPENCODE_BINARY ?? 'opencode');
    return true;
  } catch {
    return false;
  }
}

const available = cliResolves();

describe.skipIf(!available)('real OpenCode CLI', () => {
  it('resolves to a real executable, not an npm .cmd shim', () => {
    const invocation = resolveInvocation(process.env.OPENCODE_BINARY ?? 'opencode');
    expect(invocation.file).toMatch(/opencode/i);
    expect(invocation.file.toLowerCase().endsWith('.cmd')).toBe(false);
    expect(invocation.file.toLowerCase().endsWith('.ps1')).toBe(false);
  });

  it('answers --version with its version string', async () => {
    const result = await runProcess({
      cwd: process.cwd(),
      args: ['--version'],
      timeoutMs: 30_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/opencode\s+v?\d+/iu);
  });

  it('lists models in provider/model form', async () => {
    const models = await new ModelManager({ ttlMs: 0 }).list({ refresh: true });
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.id).toMatch(/^[A-Za-z0-9][\w.~-]*\/\S+$/u);
      expect(model.provider.length).toBeGreaterThan(0);
      expect(model.name.length).toBeGreaterThan(0);
    }
    // The manager also formats ids for the Telegram menu.
    expect(new ModelManager().formatDisplay(models[0]!.id)).not.toBe('');
  });

  it('lists sessions as JSON for a project directory', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'remotecode-int-'));
    const sessions = await new SessionManager({ timeoutMs: 60_000 }).listRemote(projectDir);
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('verifies context: unknown ids are missing, real CLI stays authoritative', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'remotecode-int-'));
    const manager = new SessionManager({ timeoutMs: 60_000 });
    const check = await manager.verifyContext(projectDir, 'ses_definitely_not_real');
    expect(check).toBe('missing');
    // An empty id is missing by definition (never spawns anything).
    expect(await manager.verifyContext(projectDir, '')).toBe('missing');
  });
});
