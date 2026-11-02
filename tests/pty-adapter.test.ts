import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PtyAdapter, isPtyAvailable, encodeLiteral, KEYS } from '../src/cli/pty-adapter.js';

/**
 * Terminal Mode tests.
 *
 * `encodeLiteral`/`KEYS` are pure and always run. The PTY cases spawn a REAL
 * pseudo terminal around a fixture TUI that emits the same kind of escape
 * sequences the OpenCode TUI produces — including a sequence split across two
 * writes and an alternative-screen round trip. They are skipped when node-pty
 * cannot be loaded on this machine (Chat Mode stays unaffected in that case).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'tty-emitter.cjs');

/** Polls `read` until `ok` holds or the deadline passes (never hangs). */
async function waitFor(read: () => string, ok: (value: string) => boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for terminal output; screen was:\n${value}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function spawnFixture(): PtyAdapter {
  return new PtyAdapter({
    cwd: os.tmpdir(),
    binary: process.execPath,
    argv: [fixture],
    cols: 80,
    rows: 24,
  });
}

describe('encodeLiteral', () => {
  it('turns newlines into a single carriage return (one submit)', () => {
    expect(encodeLiteral('l1\nl2\r\nl3')).toBe('l1\rl2\rl3');
  });

  it('strips control characters so no escape sequence can be injected', () => {
    expect(encodeLiteral('a\x1b[31mb\x07c\x00d')).toBe('a[31mbcd');
  });

  it('keeps tabs and normal text untouched', () => {
    expect(encodeLiteral('a\tb — привет')).toBe('a\tb — привет');
  });

  it('is safe on empty input', () => {
    expect(encodeLiteral('')).toBe('');
  });
});

describe('KEYS', () => {
  it('maps curated keys to their terminal sequences', () => {
    expect(KEYS.enter).toBe('\r');
    expect(KEYS.up).toBe('\x1b[A');
    expect(KEYS.down).toBe('\x1b[B');
    expect(KEYS.backspace).toBe('\x7f');
    expect(KEYS.ctrlc).toBe('\x03');
    expect(KEYS.escape).toBe('\x1b');
  });
});

const ptyAvailable = isPtyAvailable();

describe.skipIf(!ptyAvailable)('PtyAdapter with a real pseudo terminal', () => {
  it('renders TUI escape codes as a plain ANSI-free screen and sees the exit', async () => {
    const adapter = spawnFixture();
    const exitPromise = new Promise<{ code: number | null; signal: number | null } | null>(
      (resolve) => adapter.onExit((code, signal) => resolve({ code, signal })),
    );

    try {
      // The fixture emits its stages ~40ms apart; wait for the last one.
      const screen = await waitFor(
        () => adapter.screen.render().join('\n'),
        (value) => value.includes('bottom line'),
        15_000,
      );

      // Plain render never leaks raw escape codes to Telegram.
      expect(screen).not.toContain('\x1b');
      expect(screen).toContain('Hello RemoteCode');
      expect(screen).toContain('RED plain'); // colour applied, stripped in render
      expect(screen).toContain('At row 10 col 5'); // cursor addressing worked
      expect(screen).toContain('GREEN after split'); // ESC [ split across writes
      expect(screen).toContain('line before scroll');
      // The alt-buffer round trip ended with the main screen restored.
      expect(screen).not.toContain('ALT BUFFER ONLY');

      // The fixture exits on its own: the adapter reports the real exit code.
      const exit = await exitPromise;
      expect(exit?.code).toBe(0);
      expect(adapter.alive).toBe(false);
    } finally {
      adapter.dispose();
    }
  }, 25_000);

  it('dispose() kills the terminal and is idempotent', async () => {
    const adapter = spawnFixture();
    expect(adapter.alive).toBe(true);

    adapter.dispose();
    expect(adapter.alive).toBe(false);
    // Second dispose and post-dispose operations are harmless no-ops.
    expect(() => adapter.dispose()).not.toThrow();
    expect(() => adapter.write('x')).not.toThrow();
    expect(() => adapter.resize(100, 30)).not.toThrow();
  });

  it('reports a pid while alive and tolerates onExit replay', async () => {
    const adapter = spawnFixture();
    // node-pty may briefly report 0 before initialisation — then null.
    const pid = adapter.pid;
    expect(pid === null || (typeof pid === 'number' && pid > 0)).toBe(true);

    const late: Array<{ code: number | null }> = [];
    adapter.onExit((code) => late.push({ code })); // registered while alive
    adapter.dispose();

    // A listener registered after death would replay; here we only require that
    // registering never throws and dispose stays safe.
    expect(() => adapter.onExit(() => undefined)).not.toThrow();
    expect(adapter.alive).toBe(false);
    expect(late.length).toBeLessThanOrEqual(1);
  });
});
