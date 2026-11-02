/**
 * The OpenCode CLI adapter: sends one prompt and streams the real answer.
 *
 * `streamRun()` is an async generator that yields `RunProgress` events while the
 * CLI runs and finally RETURNS the aggregated `RunResult`. It is driven by the
 * authoritative completion signal — the child process exit — never by a timer.
 * The optional `timeoutMs` is purely a HANG guard: "no output AND no exit for
 * timeoutMs" kills the child tree and reports the timeout in the result.
 *
 * Cancellation flows through `opts.signal`: aborting kills the child tree
 * (via runProcess) and marks the result `cancelled: true` with the abort reason
 * as the error message.
 *
 * Output parsing is deliberately paranoid: stdout is consumed as NDJSON, every
 * line is JSON.parse'd inside try/catch, malformed lines and unknown event
 * shapes are ignored (logged at debug), and nothing in the parse path can throw
 * past the generator.
 */

import type { RunProgress, RunResult } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { stripAnsi, truncateMiddle } from '../utils/telegram-text.js';
import { ProcessTimeoutError, runProcess, type RunProcessResult } from './process-runner.js';

const log = createLogger('opencode-adapter');

/** Cap for the unterminated NDJSON tail (defence against newline-free floods). */
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

/** Characters of stderr kept as the human-readable error message. */
const STDERR_TAIL_CHARS = 2_000;

/** Max length of a tool hint inside a progress label. */
const TOOL_HINT_MAX = 120;

/** Text parts are distinct assistant paragraphs → separate them visually. */
const TEXT_JOIN = '\n\n';

export interface StreamRunOptions {
  /** Project directory; OpenCode runs inside it (its cwd). */
  cwd: string;
  /** The prompt. ALWAYS passed as one argv element — newlines are preserved. */
  message: string;
  /** Native OpenCode session id (`ses_…`) to continue, or null to start fresh. */
  sessionId?: string | null;
  /** Model id in `provider/model` form, or null for the CLI default. */
  model?: string | null;
  /** Adds `--auto` (auto-approve permissions). Default false — logged loudly. */
  autoApprove?: boolean;
  /** OpenCode agent name (`--agent`), or null. */
  agent?: string | null;
  /** Session title (`--title`), or null. */
  title?: string | null;
  /** Abort → kill the child tree → `cancelled: true` in the result. */
  signal?: AbortSignal;
  /** Hang guard: no output AND no exit for this long → kill and report. */
  timeoutMs?: number;
}

/** Internal event queue item: a progress to yield, or a lazy final result. */
type QueueItem =
  | { progress: RunProgress }
  /**
   * The final result is a THUNK: it must be materialised only after the
   * unterminated NDJSON tail has been parsed, otherwise text parts carried by
   * that tail would be missing from the returned RunResult.
   */
  | { take: () => RunResult };

/** Test seams: point the adapter at a fixture process instead of the real CLI. */
export interface OpenCodeAdapterOptions {
  /** Overrides the resolved OpenCode binary. */
  binary?: string;
  /** Overrides the leading `run --format json` argv segment. */
  argvOverride?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Best-effort human label for a `tool_use` part, e.g. `write src/index.ts`.
 * Reads only well-known optional fields; never throws on unexpected shapes.
 */
function describeToolPart(part: unknown): string | null {
  const record = asRecord(part);
  if (record === null) return null;
  const tool = typeof record.tool === 'string' ? record.tool.trim() : '';
  if (tool.length === 0) return null;

  const state = asRecord(record.state);
  for (const key of ['summary', 'title'] as const) {
    const value = state === null ? undefined : state[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return `${tool} ${truncateMiddle(value.trim(), TOOL_HINT_MAX)}`;
    }
  }

  const input = state === null ? null : asRecord(state.input);
  if (input !== null) {
    for (const key of [
      'file_path',
      'filePath',
      'path',
      'command',
      'pattern',
      'url',
      'query',
      'description',
      'prompt',
    ] as const) {
      const value = input[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return `${tool} ${truncateMiddle(value.trim(), TOOL_HINT_MAX)}`;
      }
    }
  }

  return tool;
}

/** Extracts a human message from an `error`-style event, if any. */
function extractErrorMessage(event: Record<string, unknown>): string | null {
  for (const key of ['error', 'message'] as const) {
    const direct = event[key];
    if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
    const nested = asRecord(direct);
    if (nested !== null && typeof nested.message === 'string' && nested.message.trim().length > 0) {
      return nested.message.trim();
    }
  }
  const part = asRecord(event.part);
  if (part !== null && typeof part.text === 'string' && part.text.trim().length > 0) {
    return part.text.trim();
  }
  return null;
}

/** Last `n` characters of stderr, ANSI-stripped, for the failure message. */
function stderrTail(stderr: string): string {
  const clean = stripAnsi(stderr).trim();
  return clean.length > STDERR_TAIL_CHARS ? clean.slice(-STDERR_TAIL_CHARS) : clean;
}

export class OpenCodeAdapter {
  private readonly defaults: OpenCodeAdapterOptions;

  constructor(defaults: OpenCodeAdapterOptions = {}) {
    this.defaults = defaults;
  }

  /**
   * Run one prompt and stream progress.
   *
   * Yields `RunProgress` events:
   * - `{kind:'session'}` — the native OpenCode session id (first time it is seen),
   * - `{kind:'text'}`    — assistant text parts,
   * - `{kind:'tool'}`    — tool invocations with a short human label,
   * - `{kind:'status'}`  — lifecycle notices (child pid, hang guard, CLI errors).
   *
   * Returns `RunResult` when the child exits. NEVER throws for CLI output
   * problems; spawn/configuration failures are reported through the result.
   */
  async *streamRun(
    opts: StreamRunOptions,
  ): AsyncGenerator<RunProgress, RunResult, void> {
    const message = typeof opts.message === 'string' ? opts.message : '';
    if (message.trim().length === 0) {
      yield { kind: 'status', status: 'refusing to run an empty prompt' };
      return {
        sessionId: '',
        opencodeSessionId: opts.sessionId ?? null,
        text: '',
        tools: [],
        ok: false,
        exitCode: null,
        error: 'message must not be empty',
        cancelled: false,
      };
    }

    // ── argv (shell-free; the prompt stays exactly one element) ────────────
    const argv: string[] = [...(this.defaults.argvOverride ?? ['run', '--format', 'json'])];
    if (opts.sessionId !== undefined && opts.sessionId !== null && opts.sessionId !== '') {
      argv.push('-s', opts.sessionId);
    }
    if (opts.model !== undefined && opts.model !== null && opts.model !== '') {
      argv.push('-m', opts.model);
    }
    if (opts.autoApprove === true) {
      argv.push('--auto');
      log.warn(
        { cwd: opts.cwd, model: opts.model ?? null },
        'auto-approve ENABLED for this run: OpenCode may execute dangerous tools without asking',
      );
    }
    if (opts.agent !== undefined && opts.agent !== null && opts.agent !== '') {
      argv.push('--agent', opts.agent);
    }
    if (opts.title !== undefined && opts.title !== null && opts.title !== '') {
      argv.push('--title', opts.title);
    }
    argv.push(message);

    // ── run state ──────────────────────────────────────────────────────────
    let seenSessionId: string | null = null;
    const textParts: string[] = [];
    const toolLabels: string[] = [];
    const knownTools = new Set<string>();
    const errorNotes: string[] = [];
    let pending = '';

    const queue: QueueItem[] = [];
    let notify: (() => void) | null = null;
    const push = (item: QueueItem): void => {
      queue.push(item);
      notify?.();
    };

    // ── hang guard (idle-based; the exit itself signals completion) ────────
    const internal = new AbortController();
    let hangError: ProcessTimeoutError | null = null;
    let hangTimer: NodeJS.Timeout | null = null;

    const disarmHangTimer = (): void => {
      if (hangTimer !== null) {
        clearTimeout(hangTimer);
        hangTimer = null;
      }
    };
    const armHangTimer = (): void => {
      const timeoutMs = opts.timeoutMs;
      if (
        hangError !== null ||
        timeoutMs === undefined ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0
      ) {
        return;
      }
      disarmHangTimer();
      hangTimer = setTimeout(() => {
        hangTimer = null;
        hangError = new ProcessTimeoutError(
          `OpenCode produced no output for ${timeoutMs}ms — the run looks hung and was killed`,
          timeoutMs,
        );
        log.warn({ cwd: opts.cwd, timeoutMs }, 'hang guard tripped — killing opencode');
        push({
          progress: {
            kind: 'status',
            status: `hang guard: no output for ${timeoutMs}ms, killing opencode`,
          },
        });
        internal.abort(hangError);
      }, timeoutMs);
      hangTimer.unref();
    };

    // ── external cancellation ──────────────────────────────────────────────
    const external = opts.signal;
    const onExternalAbort = (): void => {
      internal.abort(external?.reason ?? 'cancelled');
    };
    if (external !== undefined) {
      if (external.aborted) {
        return {
          sessionId: '',
          opencodeSessionId: opts.sessionId ?? null,
          text: '',
          tools: [],
          ok: false,
          exitCode: null,
          error:
            typeof external.reason === 'string' ? external.reason : 'cancelled before start',
          cancelled: true,
        };
      }
      external.addEventListener('abort', onExternalAbort, { once: true });
    }

    // ── NDJSON parsing ─────────────────────────────────────────────────────
    const handleEventLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (line.length === 0) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log.debug({ line: truncateMiddle(line, 200) }, 'ignoring non-JSON line from opencode run --format json');
        return;
      }

      const event = asRecord(parsed);
      if (event === null) return;

      // Every event carries sessionID — that is how we learn the native id.
      const sessionID = typeof event.sessionID === 'string' ? event.sessionID : null;
      if (sessionID !== null && sessionID !== seenSessionId) {
        seenSessionId = sessionID;
        push({ progress: { kind: 'session', opencodeSessionId: sessionID } });
      }

      switch (event.type) {
        case 'text': {
          const part = asRecord(event.part);
          const text = part !== null && typeof part.text === 'string' ? part.text : null;
          if (text !== null && text.length > 0) {
            textParts.push(text);
            push({ progress: { kind: 'text', text } });
          }
          break;
        }
        case 'tool_use': {
          const label = describeToolPart(event.part);
          if (label !== null) {
            // Live progress on every use; the aggregated list stays unique+ordered.
            push({ progress: { kind: 'tool', tool: label } });
            if (!knownTools.has(label)) {
              knownTools.add(label);
              toolLabels.push(label);
            }
          }
          break;
        }
        case 'error': {
          const messageText = extractErrorMessage(event);
          if (messageText !== null) {
            errorNotes.push(messageText);
            push({
              progress: { kind: 'status', status: `opencode error: ${truncateMiddle(messageText, TOOL_HINT_MAX)}` },
            });
          }
          break;
        }
        default:
          // step_start / step_finish / unknown shapes: sessionID already handled.
          break;
      }
    };

    const feed = (chunk: string): void => {
      pending += chunk;
      if (pending.length > MAX_PENDING_CHARS) {
        log.warn({ bytes: pending.length }, 'NDJSON buffer overflow — dropping pending tail');
        pending = '';
        return;
      }
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        handleEventLine(line);
        index = pending.indexOf('\n');
      }
    };

    /**
     * Parse a final line that arrived without a trailing newline. The parsed
     * progress items are pushed into the queue; the drain loop reorders them
     * ahead of the result that is waiting at the head.
     */
    const flushPending = (): void => {
      if (pending.trim().length === 0) return;
      const tailLine = pending;
      pending = '';
      handleEventLine(tailLine);
    };

    // ── result builders ────────────────────────────────────────────────────
    const buildResult = (proc: RunProcessResult): RunResult => {
      const cancelled = external?.aborted === true && hangError === null;
      const tail = stderrTail(proc.stderr);
      let error: string | null = null;

      if (hangError !== null) {
        error = hangError.message;
      } else if (cancelled) {
        error = typeof external?.reason === 'string' ? external.reason : 'cancelled';
      } else if (proc.code !== 0 || proc.killed) {
        // The exit code is authoritative — only failures need a message.
        if (errorNotes.length > 0) {
          error = errorNotes.join('\n');
        } else if (tail.length > 0) {
          error = tail;
        } else if (proc.signal !== null) {
          error = `opencode was killed by ${proc.signal}`;
        } else {
          error = `opencode exited with code ${proc.code === null ? 'unknown' : String(proc.code)}`;
        }
      }

      const ok = proc.code === 0 && !proc.killed && !proc.timedOut;
      return {
        sessionId: '',
        opencodeSessionId: seenSessionId ?? opts.sessionId ?? null,
        text: textParts.join(TEXT_JOIN),
        tools: [...toolLabels],
        ok,
        exitCode: proc.code,
        error: ok ? null : (error ?? 'opencode run failed'),
        cancelled,
      };
    };

    const buildFailureResult = (err: unknown): RunResult => ({
      sessionId: '',
      opencodeSessionId: opts.sessionId ?? null,
      text: textParts.join(TEXT_JOIN),
      tools: [...toolLabels],
      ok: false,
      exitCode: null,
      error: err instanceof Error ? err.message : String(err),
      cancelled: external?.aborted === true,
    });

    // ── run and drain ──────────────────────────────────────────────────────
    let completed = false;
    /** True once the unterminated NDJSON tail has been parsed (or found empty). */
    let tailFlushed = false;
    try {
      armHangTimer();

      const runPromise = runProcess({
        cwd: opts.cwd,
        args: argv,
        binary: this.defaults.binary,
        signal: internal.signal,
        onSpawn: (pid) => {
          // surfaced as a status so the ProcessManager can track/kill the pid.
          push({ progress: { kind: 'status', status: `opencode run pid=${pid}` } });
        },
        onStdout: (chunk) => {
          armHangTimer();
          feed(chunk);
        },
        onStderr: (chunk) => {
          armHangTimer();
          log.debug({ chunk: truncateMiddle(chunk.trim(), 400) }, 'opencode stderr');
        },
      });

      // Process exit is THE completion signal; the promise always settles.
      // The result itself is built lazily (after the tail flush — see below).
      void runPromise.then(
        (proc) => push({ take: () => buildResult(proc) }),
        (err: unknown) => push({ take: () => buildFailureResult(err) }),
      );

      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolveWait) => {
            notify = () => {
              notify = null;
              resolveWait();
            };
          });
          continue;
        }

        // PEEK at the head: the result must stay in the queue until every
        // progress item that was flushed after it has been yielded.
        const head = queue[0]!;
        if ('progress' in head) {
          queue.shift();
          yield head.progress;
          continue;
        }

        // Head is the final result. Parse a trailing NDJSON line that arrived
        // without a newline FIRST — it may carry the last text part.
        if (!tailFlushed) {
          tailFlushed = true;
          flushPending();
          if (queue.length > 1) {
            // The flushed progress items were pushed BEHIND the result — move
            // them in front so they are yielded in chronological order.
            const flushed = queue.splice(1);
            queue.unshift(...flushed);
            continue;
          }
        }

        queue.shift();
        completed = true;
        disarmHangTimer();
        // Materialise the result NOW: the tail flush above (and any progress
        // it produced) has already updated textParts/tools by this point.
        return head.take();
      }
    } finally {
      disarmHangTimer();
      if (external !== undefined) {
        external.removeEventListener('abort', onExternalAbort);
      }
      if (!completed && !internal.signal.aborted) {
        // The consumer stopped iterating — never leave an orphaned child.
        log.warn({ cwd: opts.cwd }, 'stream consumer stopped early — killing opencode child');
        internal.abort('abandoned');
      }
    }
  }

  /** Convenience wrapper: drain `streamRun()` and return the final result. */
  async run(opts: StreamRunOptions): Promise<RunResult> {
    const iterator = this.streamRun(opts);
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) return step.value;
    }
  }
}
