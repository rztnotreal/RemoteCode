/**
 * Interactive PTY adapter for Terminal Mode.
 *
 * Chat Mode drives `opencode run` (one child per prompt); Terminal Mode keeps a
 * LONG-LIVED pseudo terminal attached to the OpenCode TUI in a project
 * directory. The raw byte stream from the TUI is fed into a VirtualTerminal so
 * Telegram always receives a rendered screen instead of escape codes.
 *
 * node-pty is a native module and may be missing or unbuildable on a given
 * machine. It is therefore loaded lazily through `createRequire`: when it is
 * unavailable this module throws a descriptive error at construction time and
 * the bot degrades to Chat Mode instead of crashing at import time.
 */

import { createRequire } from 'node:module';

import { getConfig } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { resolveInvocation } from './process-runner.js';
import { VirtualTerminal } from './terminal-parser.js';

const log = createLogger('pty-adapter');

const require = createRequire(import.meta.url);

/** Minimal structural view of the node-pty process we rely on. */
interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
      /**
       * Windows only: use the bundled conpty.dll (modern ConPTY backend).
       * The classic backend forks a `conpty_console_list_agent` helper on
       * kill() that prints "AttachConsole failed" when the pty already
       * exited — DLL mode skips it entirely. Optional, with fallback.
       */
      useConptyDll?: boolean;
    },
  ): PtyProcess;
}

/**
 * Curated key sequences exposed to Telegram. RemoteCode must never become a
 * general-purpose shell, so only navigation/editing keys are listed here.
 */
export const KEYS: Record<string, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  enter: '\r',
  backspace: '\x7f',
  escape: '\x1b',
  tab: '\t',
  ctrlc: '\x03',
  ctrld: '\x04',
};

/**
 * Turns user text into bytes that type the SAME text into the TUI.
 *
 * Newlines become a single CR (submit once — a multi-line Telegram message must
 * never be submitted as several independent inputs), and every other control
 * character is stripped so a message cannot inject escape sequences into the
 * terminal (ESC, BEL, cursor moves, ...).
 */
export function encodeLiteral(text: string): string {
  const cleaned = String(text ?? '')
    // C0 controls except TAB (\x09) and LF (\x0a); DEL too.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '');
  return cleaned.replace(/\r\n|\n|\r/gu, '\r');
}

export interface PtyAdapterOptions {
  /** Working directory — the project the TUI runs in. */
  cwd: string;
  cols?: number;
  rows?: number;
  /** Extra argv (e.g. `-s <sessionId>` to continue a session). */
  extraArgs?: string[];
  /** Environment overrides merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the OpenCode binary (default: configured CLI). */
  binary?: string;
  /** Test seam: replaces the CLI argv (default: configured OPENCODE_ARGS). */
  argv?: string[];
}

export type PtyExitListener = (code: number | null, signal: number | null) => void;

let cachedPty: PtyModule | null = null;
let ptyLoadError: Error | null = null;

/** Loads node-pty once; rethrows a helpful message when it is unusable. */
function loadPty(): PtyModule {
  if (cachedPty !== null) return cachedPty;
  if (ptyLoadError !== null) throw ptyLoadError;
  try {
    cachedPty = require('node-pty') as PtyModule;
    return cachedPty;
  } catch (error) {
    ptyLoadError = new Error(
      'node-pty недоступен — Terminal Mode отключён, Chat Mode продолжает работать. ' +
        'Для включения установите нативные зависимости сборки ' +
        '(Windows: Visual Studio Build Tools; Linux: build-essential, python3) и переустановите пакеты. ' +
        `Причина: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw ptyLoadError;
  }
}

/** True when node-pty can be loaded on this machine (Chat Mode is unaffected). */
export function isPtyAvailable(): boolean {
  try {
    loadPty();
    return true;
  } catch {
    return false;
  }
}

export class PtyAdapter {
  private readonly proc: PtyProcess;

  /** Rendered virtual screen fed by the PTY output. */
  public readonly screen: VirtualTerminal;

  private readonly exitListeners: PtyExitListener[] = [];

  private disposed = false;

  private exited = false;

  /** Exit code/signal recorded when the process died (for late listeners). */
  private lastExit: { code: number | null; signal: number | null } | null = null;

  constructor(options: PtyAdapterOptions) {
    const config = getConfig();
    const cols = Math.max(2, Math.floor(options.cols ?? 120));
    const rows = Math.max(2, Math.floor(options.rows ?? 40));

    // Resolves npm shims to the real executable (Windows cannot spawn .cmd).
    const invocation = resolveInvocation(options.binary ?? config.opencodeBinary);
    const args =
      options.argv !== undefined
        ? [...invocation.prefixArgs, ...options.argv]
        : [...invocation.prefixArgs, ...config.opencodeArgs, ...(options.extraArgs ?? [])];

    this.screen = new VirtualTerminal(cols, rows, {
      onResponse: (response) => {
        if (this.disposed || this.exited) return;
        try {
          this.proc.write(response);
        } catch (error) {
          log.debug({ err: describe(error) }, 'failed to answer terminal query');
        }
      },
    });

    const pty = loadPty();
    const spawnOptions = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        TERM: process.env.TERM ?? 'xterm-256color',
        COLORTERM: process.env.COLORTERM ?? 'truecolor',
      },
    };

    // Prefer the bundled conpty.dll backend on Windows (it does not fork the
    // console-list helper that spams "AttachConsole failed" when the child
    // already exited). If the DLL cannot be used, fall back to classic ConPTY.
    if (process.platform === 'win32') {
      try {
        this.proc = pty.spawn(invocation.file, args, { ...spawnOptions, useConptyDll: true });
      } catch (error) {
        log.warn(
          { err: describe(error) },
          'conpty.dll backend unavailable — falling back to classic ConPTY',
        );
        this.proc = pty.spawn(invocation.file, args, spawnOptions);
      }
    } else {
      this.proc = pty.spawn(invocation.file, args, spawnOptions);
    }

    this.proc.onData((data) => {
      this.screen.write(data);
    });

    this.proc.onExit((event) => {
      this.exited = true;
      const code = typeof event.exitCode === 'number' ? event.exitCode : null;
      const signal = typeof event.signal === 'number' ? event.signal : null;
      this.lastExit = { code, signal };
      log.info({ pid: this.pid, code, signal }, 'pty exited');
      for (const listener of [...this.exitListeners]) {
        try {
          listener(code, signal);
        } catch (error) {
          log.debug({ err: describe(error) }, 'pty exit listener threw');
        }
      }
    });

    log.info({ pid: this.pid, cwd: options.cwd, cols, rows, args }, 'pty spawned');
  }

  /** OS pid of the TUI process (node-pty may report 0 before init: then null). */
  get pid(): number | null {
    const pid = this.proc.pid;
    return typeof pid === 'number' && pid > 0 ? pid : null;
  }

  get alive(): boolean {
    return !this.exited && !this.disposed;
  }

  /** Registers an exit callback (also fires for `dispose()`). */
  onExit(listener: PtyExitListener): void {
    this.exitListeners.push(listener);
    if (this.exited && this.lastExit !== null) {
      // Already dead: deliver immediately so bookkeeping never waits forever.
      try {
        listener(this.lastExit.code, this.lastExit.signal);
      } catch {
        /* listener errors are irrelevant during replay */
      }
    }
  }

  /** Writes raw bytes to the terminal (see `encodeLiteral` / `KEYS`). */
  write(data: string): void {
    if (this.disposed || this.exited || typeof data !== 'string' || data.length === 0) return;
    try {
      this.proc.write(data);
    } catch (error) {
      log.debug({ err: describe(error) }, 'pty write failed');
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || this.exited) return;
    const width = Math.max(2, Math.floor(cols));
    const height = Math.max(2, Math.floor(rows));
    try {
      this.proc.resize(width, height);
      this.screen.resize(width, height);
    } catch (error) {
      log.debug({ err: describe(error) }, 'pty resize failed');
    }
  }

  /** Kills the TUI. Idempotent and safe to call from shutdown paths. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.proc.kill();
    } catch (error) {
      log.debug({ err: describe(error) }, 'pty kill failed');
    }
    // Listeners are intentionally KEPT: the exit event must still reach
    // observers (e.g. TerminalSessionManager bookkeeping) after a dispose.
    // A late exit can only mark `exited` again — it cannot resurrect state.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
