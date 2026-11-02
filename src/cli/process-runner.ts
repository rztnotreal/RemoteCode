/**
 * Low-level child-process plumbing shared by every RemoteCode module.
 *
 * Security: every spawn uses `shell: false` and a pre-split argv array, so user
 * text (prompts, session ids, model ids) can NEVER be interpreted by a shell.
 * The OpenCode binary is resolved by scanning the filesystem directly — the npm
 * `.ps1`/`.cmd` shims are deliberately bypassed in favour of the real
 * executable (`resolveInvocation`), which is also required on Windows, where
 * Node refuses to spawn `.cmd` files without a shell.
 *
 * Timeout semantics: `timeoutMs` is a hard WALL-CLOCK deadline. The higher
 * layers implement their own idle/hang guards on top (see opencode-adapter).
 * When the deadline fires the child tree is killed and the promise RESOLVES
 * with `timedOut: true` — a timeout is a result, not an exception.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getConfig } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('process-runner');

/** Hard cap per stream so a runaway child cannot exhaust our memory. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Grace period between the polite kill and the SIGKILL escalation. */
const KILL_GRACE_MS = 3_000;

/** Executable suffixes tried on Windows when a bare command name is given. */
const DEFAULT_WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Typed timeout signal. `runProcess` itself reports timeouts through
 * `RunProcessResult.timedOut`; higher layers (e.g. `ModelManager`) throw this
 * to turn that fact into a descriptive, catchable domain error.
 */
export class ProcessTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'ProcessTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface RunProcessOptions {
  /** Working directory of the child. Must exist. */
  cwd: string;
  /** argv AFTER the executable — never passed through a shell. */
  args: string[];
  /** Hard wall-clock deadline; the child is killed when it fires. */
  timeoutMs?: number;
  /** Aborting kills the child tree; the promise still resolves (`killed: true`). */
  signal?: AbortSignal;
  /** Environment for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Receives decoded UTF-8 stdout chunks as they arrive (for streaming). */
  onStdout?(chunk: string): void;
  /** Receives decoded UTF-8 stderr chunks as they arrive. */
  onStderr?(chunk: string): void;
  /**
   * Overrides the configured OpenCode binary (`config.opencodeBinary`). Useful
   * for tests and for future non-OpenCode helpers. When omitted the binary is
   * resolved from configuration on every call.
   */
  binary?: string;
  /** Called exactly once with the OS pid right after a successful spawn. */
  onSpawn?(pid: number): void;
}

export interface RunProcessResult {
  /** Process exit code; null when the child died from a signal. */
  code: number | null;
  /** Terminating signal, when the child was killed by one. */
  signal: NodeJS.Signals | null;
  /** Full stdout, decoded from the raw buffers at the end (UTF-8 safe). */
  stdout: string;
  /** Full stderr, decoded from the raw buffers at the end (UTF-8 safe). */
  stderr: string;
  /** True when `timeoutMs` fired and we killed the tree. */
  timedOut: boolean;
  /** True when we initiated termination (deadline or abort). */
  killed: boolean;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isEsrch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

/** Expands a leading `~` to the current user's home directory. */
function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** What actually has to be executed for a configured command. */
export interface BinaryInvocation {
  /** Absolute path of the executable (never a shell, never a `.cmd` shim). */
  file: string;
  /** Arguments that must precede the caller's argv (e.g. a JS entry point). */
  prefixArgs: string[];
}

/** Extensions whose files are batch scripts (unspawnable without a shell). */
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

/** Extensions executed through Node when a shim points at a JS entry. */
const NODE_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** Bytes read from a candidate file when deciding whether it is a shim. */
const SHIM_HEAD_BYTES = 8 * 1024;

/**
 * npm installs `.cmd`/`.ps1`/shell shims instead of the real binary. Node on
 * Windows REFUSES to spawn `.cmd`/`.bat` without a shell (EINVAL, CVE-2024-27980),
 * and going through `cmd.exe` would re-introduce shell parsing for user text.
 * So the shim is parsed here and the executable (or `node <entry.js>`) it points
 * at is used directly — argv stays an array and no shell is ever involved.
 *
 * Returns null when the file is not a recognisable shim.
 */
function parseShim(shimPath: string): BinaryInvocation | null {
  const extension = path.extname(shimPath).toLowerCase();
  // Real executables are never shims — never read a multi-megabyte binary.
  if (extension === '.exe' || extension === '.com') return null;

  // Only the head of the file matters: npm shims are tiny text files and their
  // target path appears within the first few lines.
  let content: string;
  try {
    const fd = fs.openSync(shimPath, 'r');
    try {
      const buffer = Buffer.alloc(SHIM_HEAD_BYTES);
      const read = fs.readSync(fd, buffer, 0, SHIM_HEAD_BYTES, 0);
      content = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const isBatch = BATCH_EXTENSIONS.has(extension) || content.startsWith('@ECHO off');
  const isShell = content.startsWith('#!');
  if (!isBatch && !isShell) return null;

  const dir = path.dirname(shimPath);
  const candidates: string[] = [];

  if (isBatch) {
    // `"%dp0%\node_modules\pkg\bin\opencode.exe" %*` (npm's generated cmd).
    const pattern = /"%?(?:dp0|~dp0)%?\\([^"]+)"/gi;
    for (const match of content.matchAll(pattern)) {
      const relative = match[1];
      if (relative !== undefined && relative.length > 0) candidates.push(relative);
    }
  } else {
    // `exec "$basedir/node_modules/pkg/bin/opencode.js" "$@"` (npm sh shim).
    const pattern = /["']?\$(?:basedir|dp0)[\\/]+([^"'\s]+)["']?/gi;
    for (const match of content.matchAll(pattern)) {
      const relative = match[1];
      if (relative !== undefined && relative.length > 0) candidates.push(relative);
    }
  }

  const resolved = candidates
    .map((relative) => path.resolve(dir, relative))
    .filter((candidate) => isFile(candidate));

  const script = resolved.find((candidate) =>
    NODE_SCRIPT_EXTENSIONS.has(path.extname(candidate).toLowerCase()),
  );
  if (script !== undefined) {
    return { file: process.execPath, prefixArgs: [script] };
  }
  const executable = resolved[0];
  if (executable !== undefined) {
    return { file: executable, prefixArgs: [] };
  }

  // A recognisable shim whose target is gone: fail loudly instead of letting
  // spawn() produce an opaque EINVAL later.
  throw new Error(
    `OpenCode shim "${shimPath}" does not point to an existing executable. ` +
      'Set OPENCODE_BINARY to the full path of the real opencode executable.',
  );
}

/**
 * Resolve the OpenCode binary to an absolute path WITHOUT involving a shell.
 *
 * - Absolute/relative paths (or names ending in .exe/.cmd/.bat/.com) are
 *   checked on disk directly; on Windows an extension-less path also probes
 *   the standard executable suffixes.
 * - Bare command names are located by scanning `PATH` manually. On Windows the
 *   `PATHEXT` order is honoured, and the exact name is always tried first.
 * - On Windows the found file may be an npm shim (`.cmd`/`@ECHO off` script);
 *   it is unwrapped to the real executable (see `parseShim`).
 *
 * Throws a descriptive error when the binary cannot be found.
 */
export function resolveInvocation(binary: string): BinaryInvocation {
  const unquoted = (binary ?? '')
    .trim()
    .replace(/^"([^"]*)"$/u, '$1')
    .replace(/^'([^']*)'$/u, '$1');
  if (unquoted.length === 0) {
    throw new Error(
      'OpenCode binary is not configured — set OPENCODE_BINARY to the full path of the opencode executable.',
    );
  }

  const expanded = expandHome(unquoted);
  const looksLikePath =
    expanded.includes('/') ||
    expanded.includes('\\') ||
    /\.(exe|cmd|bat|com|ps1)$/i.test(expanded);

  const finish = (found: string): BinaryInvocation => {
    if (process.platform !== 'win32') return { file: found, prefixArgs: [] };
    // `.exe`/binary files are returned as-is; shims are unwrapped.
    const unwrapped = parseShim(found);
    return unwrapped ?? { file: found, prefixArgs: [] };
  };

  if (looksLikePath) {
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    if (isFile(absolute)) return finish(absolute);
    if (process.platform === 'win32' && path.extname(absolute) === '') {
      for (const suffix of DEFAULT_WINDOWS_EXTENSIONS) {
        if (isFile(absolute + suffix)) return finish(absolute + suffix);
      }
    }
    throw new Error(
      `OpenCode binary not found at "${absolute}" — set OPENCODE_BINARY to the full path of the opencode executable.`,
    );
  }

  // Bare command: scan PATH manually. A shell is never involved.
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  const directories = pathVar.split(path.delimiter).filter((entry) => entry.length > 0);
  const suffixes =
    process.platform === 'win32'
      ? [
          '',
          ...(process.env.PATHEXT?.split(';').filter((entry) => entry.length > 0) ??
            DEFAULT_WINDOWS_EXTENSIONS),
        ]
      : [''];

  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, expanded + suffix);
      if (isFile(candidate)) return finish(candidate);
    }
  }

  throw new Error(
    `OpenCode binary "${binary}" was not found on PATH (searched ${directories.length} directories). ` +
      'Set OPENCODE_BINARY to the full path of the opencode executable.',
  );
}

/** Resolved executable path only (compatibility wrapper around `resolveInvocation`). */
export function resolveBinary(binary: string): string {
  return resolveInvocation(binary).file;
}

/**
 * Kill a process AND its descendants. Idempotent: killing an already-dead
 * process is a no-op (ESRCH is swallowed).
 *
 * - Windows: `taskkill /pid <pid> /T /F` (no shell).
 * - POSIX:   signal the whole process group first (`kill(-pid)` — `runProcess`
 *            spawns detached so the child owns its group), then fall back to
 *            signalling the pid directly.
 */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.on('error', (err) => {
        log.debug(
          { err: err instanceof Error ? err.message : String(err), pid },
          'taskkill could not be started',
        );
      });
      killer.unref();
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err), pid },
        'failed to spawn taskkill',
      );
    }
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Group kill can fail (ESRCH when not a group leader, EPERM for others) —
    // fall through to signalling the pid directly.
  }

  try {
    process.kill(pid, signal);
  } catch (err) {
    if (isEsrch(err)) return; // Already dead — idempotent no-op.
    throw err;
  }
}

/** Invoke a callback without ever letting it break the run. */
function safeChunkCallback(
  callback: ((chunk: string) => void) | undefined,
  chunk: string,
): void {
  if (!callback || chunk.length === 0) return;
  try {
    callback(chunk);
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'output callback threw; ignoring',
    );
  }
}

/**
 * Spawn the OpenCode binary and collect its outcome.
 *
 * - Streams decoded stdout/stderr to the callbacks while ALSO buffering both
 *   streams (capped at 8 MB) and decoding the buffers only at the very end, so
 *   multi-byte UTF-8 sequences split across chunks are never corrupted.
 * - `timeoutMs` is a hard deadline: on expiry the child tree is killed
 *   (SIGTERM, then SIGKILL after a grace period) and the result carries
 *   `timedOut: true`.
 * - An aborted `signal` kills the child tree and resolves with `killed: true`.
 * - Only spawn failures (bad binary, bad cwd, EACCES …) reject the promise.
 */
export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise<RunProcessResult>((resolve, reject) => {
    const invocation = resolveInvocation(opts.binary ?? getConfig().opencodeBinary);
    const command = invocation.file;
    const commandArgs = [...invocation.prefixArgs, ...opts.args];

    if (opts.signal?.aborted === true) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: 'aborted before the process was started',
        timedOut: false,
        killed: true,
      });
      return;
    }

    const child = spawn(command, commandArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX only: give the child its own process group so killTree(-pid)
      // terminates the whole tree without ever touching our own group.
      detached: process.platform !== 'win32',
    });

    let settled = false;
    let timedOut = false;
    let killed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // Decoders keep callback output UTF-8 safe across arbitrary chunk borders;
    // the final result decodes the raw buffers directly.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    let deadlineTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      deadlineTimer = null;
      killTimer = null;
    };

    const kill = (signal: NodeJS.Signals): void => {
      killed = true;
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        killTree(pid, signal);
      } catch (err) {
        log.debug(
          { err: err instanceof Error ? err.message : String(err), pid, signal },
          'killTree failed',
        );
      }
      if (signal !== 'SIGKILL' && killTimer === null) {
        // Escalate if the polite request is ignored.
        killTimer = setTimeout(() => {
          killTimer = null;
          try {
            killTree(pid, 'SIGKILL');
          } catch (err) {
            log.debug(
              { err: err instanceof Error ? err.message : String(err), pid },
              'SIGKILL escalation failed',
            );
          }
        }, KILL_GRACE_MS);
        killTimer.unref();
      }
    };

    const onAbort = (): void => {
      log.debug({ pid: child.pid }, 'abort requested — killing child process');
      kill('SIGTERM');
    };
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const removeAbortListener = (): void => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    if (
      opts.timeoutMs !== undefined &&
      Number.isFinite(opts.timeoutMs) &&
      opts.timeoutMs > 0
    ) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        log.warn({ timeoutMs: opts.timeoutMs, pid: child.pid }, 'deadline exceeded — killing child process');
        kill('SIGTERM');
      }, opts.timeoutMs);
      deadlineTimer.unref();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_BUFFER_BYTES) stdoutChunks.push(chunk);
      safeChunkCallback(opts.onStdout, stdoutDecoder.write(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BUFFER_BYTES) stderrChunks.push(chunk);
      safeChunkCallback(opts.onStderr, stderrDecoder.write(chunk));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeAbortListener();
      reject(
        err instanceof Error
          ? err
          : new Error(`failed to spawn "${command}": ${String(err)}`),
      );
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeAbortListener();
      // Flush any incomplete trailing multi-byte sequence to the callbacks.
      safeChunkCallback(opts.onStdout, stdoutDecoder.end());
      safeChunkCallback(opts.onStderr, stderrDecoder.end());
      const stdout = Buffer.concat(stdoutChunks).subarray(0, MAX_BUFFER_BYTES).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).subarray(0, MAX_BUFFER_BYTES).toString('utf8');
      resolve({ code, signal, stdout, stderr, timedOut, killed });
    });

    if (child.pid !== undefined) {
      try {
        opts.onSpawn?.(child.pid);
      } catch (err) {
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'onSpawn callback threw; ignoring',
        );
      }
    }
  });
}
