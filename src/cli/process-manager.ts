/**
 * Per-session process orchestration for RemoteCode.
 *
 * One RemoteCode session maps to at most ONE in-flight OpenCode run. Messages
 * sent while a run is active are queued in a per-session FIFO and executed
 * strictly in order — two prompts are never interleaved into the same session.
 * Different sessions run concurrently with fully separate buffers and state.
 *
 * Cancellation is cooperative (AbortSignal) with a killTree() escalation for
 * the child process, so no orphaned children are left behind.
 */

import { EventEmitter } from 'node:events';

import { OpenCodeAdapter } from './opencode-adapter.js';
import { killTree } from './process-runner.js';
import {
  addMessage,
  getProject,
  getSession,
  setOpencodeSessionId,
  touchSession,
  updateSessionStatus,
} from '../database/client.js';
import type { ProcessSnapshot, Project, RunHandle, RunProgress, RunResult, Session, SessionStatus } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { now } from '../utils/ids.js';

const log = createLogger('process-manager');

/** Default ring-buffer capacity for recent output lines. */
const DEFAULT_BUFFER_LIMIT = 200;

/** Idle instances older than this are dropped by the watchdog. */
const IDLE_CLEANUP_MS = 5 * 60_000;

/** Default hung-task timeout for `reap()`. */
const DEFAULT_HANG_TIMEOUT_MS = 30 * 60_000;

/** One buffered line (user prompt, assistant reply, or terminal output). */
export interface BufferLine {
  /** Unix ms when the line was recorded. */
  at: number;
  role: 'user' | 'assistant' | 'output';
  text: string;
}

/** Live state of one tracked session process. */
export interface ProcessInstance {
  projectId: string;
  sessionId: string;
  cwd: string;
  /** OS pid of the CLI child, when it has been observed. */
  pid: number | null;
  model: string | null;
  status: SessionStatus;
  lastActivityAt: number;
  startedAt: number | null;
  currentTask: string | null;
  /** Ring buffer of recent lines, capped at `bufferLimit`. */
  buffer: BufferLine[];
  /** Abort controller of the CURRENT run (replaced for every run). */
  abortController: AbortController;
  /** The in-flight RunHandle, null while idle. */
  handle: RunHandle | null;
  /** Set by the watchdog when the run is declared hung; cleared on next run. */
  hangReason: string | null;
}

/** A message waiting for its turn in a session's FIFO queue. */
interface QueuedRun {
  message: string;
  autoApprove: boolean;
  persist: boolean;
  onProgress?: (progress: RunProgress) => void;
  resolveStart: (handle: RunHandle) => void;
  rejectStart: (error: Error) => void;
}

/** Per-session queue + serialization flag. */
interface QueueState {
  items: QueuedRun[];
  /** True while one item of this queue is executing. */
  running: boolean;
}

export interface SendOptions {
  session: Session;
  project: Project;
  message: string;
  autoApprove: boolean;
  onProgress?: (progress: RunProgress) => void;
  /**
   * Persist user/assistant messages via addMessage (default true).
   * Callers that persist the transcript themselves pass false to avoid duplicates.
   */
  persist?: boolean;
}

/** Typed event payloads emitted by ProcessManager. */
export interface ProcessStartedEvent {
  sessionId: string;
  projectId: string;
}
export interface ProcessProgressEvent {
  sessionId: string;
  projectId: string;
  progress: RunProgress;
}
export interface ProcessFinishedEvent {
  sessionId: string;
  projectId: string;
  result: RunResult;
}
export interface ProcessErrorEvent {
  sessionId: string;
  projectId: string;
  error: string;
  result: RunResult;
}
export interface ProcessCancelledEvent {
  sessionId: string;
  projectId: string;
  reason: string;
}

export interface ProcessManagerEvents {
  started: [ProcessStartedEvent];
  progress: [ProcessProgressEvent];
  finished: [ProcessFinishedEvent];
  error: [ProcessErrorEvent];
  cancelled: [ProcessCancelledEvent];
}

type Listener<T extends readonly unknown[]> = (...args: T) => void;

/**
 * Minimal strongly-typed wrapper around node's EventEmitter.
 * Hand-rolled so event names and payloads are checked at compile time.
 */
class TypedEmitter<Events extends { [K in keyof Events]: readonly unknown[] }> {
  private readonly emitter = new EventEmitter();

  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    this.emitter.on(event, listener as (...args: any[]) => void);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    this.emitter.off(event, listener as (...args: any[]) => void);
    return this;
  }

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }
}

export class ProcessManager {
  /** THE registry: RemoteCode sessionId → live process instance. */
  private readonly processes = new Map<string, ProcessInstance>();

  /** Per-session FIFO queues guaranteeing one active run per session. */
  private readonly queues = new Map<string, QueueState>();

  /** Done-promises of currently executing runs (used by shutdown()). */
  private readonly activeRuns = new Set<Promise<RunResult>>();

  private readonly emitter = new TypedEmitter<ProcessManagerEvents>();

  private readonly adapter: OpenCodeAdapter;

  private readonly bufferLimit: number;

  private stoppingWatchdog: (() => void) | null = null;

  private shuttingDown = false;

  constructor(options: { adapter?: OpenCodeAdapter; bufferLimit?: number } = {}) {
    this.adapter = options.adapter ?? new OpenCodeAdapter();
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  }

  // ── events ────────────────────────────────────────────────────────────────

  on<K extends keyof ProcessManagerEvents & string>(
    event: K,
    listener: Listener<ProcessManagerEvents[K]>,
  ): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends keyof ProcessManagerEvents & string>(
    event: K,
    listener: Listener<ProcessManagerEvents[K]>,
  ): this {
    this.emitter.off(event, listener);
    return this;
  }

  /** Emit that never lets a listener exception break the run loop. */
  private safeEmit<K extends keyof ProcessManagerEvents & string>(
    event: K,
    ...args: ProcessManagerEvents[K]
  ): void {
    try {
      this.emitter.emit(event, ...args);
    } catch (err) {
      log.warn({ err, event }, 'process event listener threw');
    }
  }

  // ── inspection ────────────────────────────────────────────────────────────

  get(sessionId: string): ProcessInstance | undefined {
    return this.processes.get(sessionId);
  }

  /** Snapshots of every tracked instance, most recently active first. */
  list(): ProcessSnapshot[] {
    return [...this.processes.values()]
      .map(ProcessManager.toSnapshot)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  snapshot(sessionId: string): ProcessSnapshot | undefined {
    const instance = this.processes.get(sessionId);
    return instance ? ProcessManager.toSnapshot(instance) : undefined;
  }

  /** True when a run is executing or messages are queued for the session. */
  isBusy(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    if (queue && (queue.running || queue.items.length > 0)) return true;
    const instance = this.processes.get(sessionId);
    return instance !== undefined && (instance.status === 'starting' || instance.status === 'running');
  }

  /** How many messages are waiting for the session's turn. */
  queueLength(sessionId: string): number {
    return this.queues.get(sessionId)?.items.length ?? 0;
  }

  private static toSnapshot(instance: ProcessInstance): ProcessSnapshot {
    return {
      sessionId: instance.sessionId,
      projectId: instance.projectId,
      cwd: instance.cwd,
      pid: instance.pid,
      model: instance.model,
      status: instance.status,
      lastActivityAt: instance.lastActivityAt,
      startedAt: instance.startedAt,
      currentTask: instance.currentTask,
    };
  }

  // ── the single write path ─────────────────────────────────────────────────

  /**
   * Send one prompt to a session. The WHOLE message (newlines included) is one
   * prompt — it is never split.
   *
   * Resolves with the RunHandle as soon as THIS message's run starts (queued
   * messages wait for their turn); `handle.done` then resolves with the result.
   * `handle.cancel()` aborts the run. `done` never rejects.
   */
  async send(opts: SendOptions): Promise<RunHandle> {
    if (this.shuttingDown) {
      throw new Error('ProcessManager is shutting down');
    }
    const { session, project, message } = opts;
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('message must not be empty');
    }
    if (session.projectId !== project.id) {
      throw new Error(`session ${session.id} does not belong to project ${project.id}`);
    }

    const instance = this.ensureInstance(session, project);
    // Refresh mutable context in case the model/path changed since last run.
    instance.projectId = project.id;
    instance.cwd = project.path;
    instance.model = session.model;

    const queue = this.ensureQueue(session.id);

    let resolveStart!: (handle: RunHandle) => void;
    let rejectStart!: (error: Error) => void;
    const started = new Promise<RunHandle>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });

    queue.items.push({
      message,
      autoApprove: opts.autoApprove,
      persist: opts.persist ?? true,
      onProgress: opts.onProgress,
      resolveStart,
      rejectStart,
    });

    void this.pump(session.id);
    return started;
  }

  private ensureInstance(session: Session, project: Project): ProcessInstance {
    let instance = this.processes.get(session.id);
    if (!instance) {
      instance = {
        projectId: project.id,
        sessionId: session.id,
        cwd: project.path,
        pid: null,
        model: session.model,
        status: 'idle',
        lastActivityAt: now(),
        startedAt: null,
        currentTask: null,
        buffer: [],
        abortController: new AbortController(),
        handle: null,
        hangReason: null,
      };
      this.processes.set(session.id, instance);
    }
    return instance;
  }

  private ensureQueue(sessionId: string): QueueState {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = { items: [], running: false };
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  /** Strictly serial drain of one session's FIFO queue. */
  private async pump(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.running) return;
    queue.running = true;
    try {
      while (!this.shuttingDown) {
        const item = queue.items.shift();
        if (!item) break;
        try {
          await this.executeItem(sessionId, item);
        } catch (err) {
          // executeItem settles its own handle; this is a last-resort guard so
          // one broken run can never wedge the session queue.
          log.error({ err, sessionId }, 'run execution failed');
        }
      }
    } finally {
      queue.running = false;
    }
  }

  /** Execute exactly one queued prompt. Never throws; always settles `done`. */
  private async executeItem(sessionId: string, item: QueuedRun): Promise<void> {
    const instance = this.processes.get(sessionId);
    if (!instance) {
      item.rejectStart(new Error(`no process instance for session ${sessionId}`));
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      item.rejectStart(new Error(`session ${sessionId} no longer exists`));
      return;
    }
    const project = getProject(session.projectId);
    if (!project) {
      item.rejectStart(new Error(`project of session ${sessionId} no longer exists`));
      return;
    }

    const controller = new AbortController();
    instance.abortController = controller;
    instance.hangReason = null;
    instance.pid = null;
    instance.status = 'starting';
    instance.startedAt = now();
    instance.lastActivityAt = instance.startedAt;
    instance.currentTask = null;
    this.updateSessionStatus(sessionId, 'starting');

    // Collected from progress events; used to enrich/repair the adapter result.
    const collectedText: string[] = [];
    const collectedTools: string[] = [];
    let sawNonSessionProgress = false;
    let opencodeSessionId = session.opencodeSessionId;

    let settleDone!: (result: RunResult) => void;
    const done = new Promise<RunResult>((resolve) => {
      settleDone = resolve;
    });
    const handle: RunHandle = {
      done,
      cancel: (reason?: string) => {
        void this.cancel(sessionId, reason ?? 'cancelled_by_user');
      },
    };
    instance.handle = handle;
    // The caller gets the handle as soon as this run actually starts.
    item.resolveStart(handle);

    this.safeEmit('started', { sessionId, projectId: instance.projectId });
    this.pushLine(instance, { at: now(), role: 'user', text: item.message });
    if (item.persist) {
      this.appendMessage(sessionId, 'user', item.message);
    }

    this.activeRuns.add(done);
    let finalResult: RunResult | null = null;
    try {
      const iterator = this.adapter.streamRun({
        cwd: instance.cwd,
        message: item.message,
        sessionId: session.opencodeSessionId,
        model: session.model,
        autoApprove: item.autoApprove,
        agent: null,
        title: null,
        signal: controller.signal,
      });

      // Manual iteration (not for-await) so the generator's RETURN value — the
      // RunResult — is captured instead of being discarded.
      let step = await iterator.next();
      while (!step.done) {
        const progress = step.value;
        instance.lastActivityAt = now();

        const pid = ProcessManager.extractPid(progress);
        if (pid !== null) instance.pid = pid;

        if (progress.kind === 'session' && progress.opencodeSessionId) {
          opencodeSessionId = progress.opencodeSessionId;
          // Persist early so a crash does not orphan the OpenCode session.
          setOpencodeSessionId(sessionId, opencodeSessionId);
          touchSession(sessionId);
        } else if (progress.kind === 'tool') {
          const task = ProcessManager.describeTool(progress.tool);
          instance.currentTask = task;
          if (task) this.pushLine(instance, { at: now(), role: 'output', text: task });
        } else if (progress.kind === 'status') {
          instance.currentTask = progress.status ?? null;
          if (progress.status) {
            this.pushLine(instance, { at: now(), role: 'output', text: progress.status });
          }
        } else if (progress.kind === 'text' && progress.text) {
          collectedText.push(progress.text);
          this.pushLine(instance, { at: now(), role: 'output', text: progress.text });
        }

        if (!sawNonSessionProgress && progress.kind !== 'session') {
          sawNonSessionProgress = true;
          if (instance.status !== 'running') {
            instance.status = 'running';
            this.updateSessionStatus(sessionId, 'running');
          }
        }

        this.safeEmit('progress', { sessionId, projectId: instance.projectId, progress });
        if (item.onProgress) {
          try {
            item.onProgress(progress);
          } catch (err) {
            log.warn({ err, sessionId }, 'onProgress callback threw');
          }
        }

        step = await iterator.next();
      }

      const adapterResult = step.value;
      const mergedText = adapterResult.text || collectedText.join('');
      const mergedTools = adapterResult.tools.length > 0 ? adapterResult.tools : [...collectedTools];

      if (instance.hangReason) {
        // The watchdog declared this run hung: surface it as a hard error even
        // though the abort arrived through the same cooperative path.
        finalResult = {
          ...adapterResult,
          sessionId,
          opencodeSessionId: adapterResult.opencodeSessionId ?? opencodeSessionId,
          text: mergedText,
          tools: mergedTools,
          ok: false,
          cancelled: false,
          error: instance.hangReason,
        };
      } else if (controller.signal.aborted) {
        finalResult = {
          ...adapterResult,
          sessionId,
          opencodeSessionId: adapterResult.opencodeSessionId ?? opencodeSessionId,
          text: mergedText,
          tools: mergedTools,
          ok: false,
          cancelled: true,
          error: adapterResult.error ?? 'cancelled',
        };
      } else {
        finalResult = {
          ...adapterResult,
          sessionId,
          opencodeSessionId: adapterResult.opencodeSessionId ?? opencodeSessionId,
          text: mergedText,
          tools: mergedTools,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = controller.signal.aborted && instance.hangReason === null;
      finalResult = {
        sessionId,
        opencodeSessionId,
        text: collectedText.join(''),
        tools: [...collectedTools],
        ok: false,
        exitCode: null,
        error: instance.hangReason ?? message,
        cancelled,
      };
    } finally {
      this.activeRuns.delete(done);
    }

    // Defensive: both branches above assign, but keep TS and future edits safe.
    if (finalResult === null) {
      finalResult = {
        sessionId,
        opencodeSessionId,
        text: collectedText.join(''),
        tools: [...collectedTools],
        ok: false,
        exitCode: null,
        error: 'run produced no result',
        cancelled: controller.signal.aborted,
      };
    }

    this.finalize(instance, item, finalResult);
    settleDone(finalResult);
  }

  /** Terminal bookkeeping shared by success, error and cancellation paths. */
  private finalize(instance: ProcessInstance, item: QueuedRun, result: RunResult): void {
    const sessionId = instance.sessionId;
    instance.lastActivityAt = now();
    instance.currentTask = null;
    instance.handle = null;
    instance.pid = null;

    if (result.opencodeSessionId) {
      setOpencodeSessionId(sessionId, result.opencodeSessionId);
      touchSession(sessionId);
    }

    if (item.persist && result.text.trim().length > 0) {
      this.appendMessage(sessionId, 'assistant', result.text);
    }
    if (result.text.trim().length > 0) {
      this.pushLine(instance, { at: now(), role: 'assistant', text: result.text });
    }

    const finalStatus: SessionStatus = result.ok || result.cancelled ? 'idle' : 'error';
    instance.status = finalStatus;
    this.updateSessionStatus(sessionId, finalStatus);

    const projectId = instance.projectId;
    if (result.cancelled) {
      this.safeEmit('cancelled', { sessionId, projectId, reason: result.error ?? 'cancelled' });
    } else if (!result.ok) {
      this.safeEmit('error', {
        sessionId,
        projectId,
        error: result.error ?? 'unknown error',
        result,
      });
    }
    this.safeEmit('finished', { sessionId, projectId, result });

    log.debug(
      { sessionId, ok: result.ok, cancelled: result.cancelled, exitCode: result.exitCode },
      'run finished',
    );
  }

  // ── cancellation ──────────────────────────────────────────────────────────

  /**
   * Cancel the currently running prompt of a session (queued messages keep
   * their turn and still run afterwards — use flushQueue() to drop them).
   * Returns false when nothing was running.
   */
  async cancel(sessionId: string, reason = 'cancelled_by_user'): Promise<boolean> {
    const instance = this.processes.get(sessionId);
    const queue = this.queues.get(sessionId);
    if (!instance || !queue || !queue.running) return false;

    instance.abortController.abort(reason);
    const pid = instance.pid;
    if (pid !== null) {
      try {
        killTree(pid, 'SIGTERM');
      } catch (err) {
        log.debug({ err, pid, sessionId }, 'killTree failed during cancel');
      }
    }

    instance.currentTask = null;
    instance.status = 'idle';
    instance.lastActivityAt = now();
    this.updateSessionStatus(sessionId, 'idle');
    this.safeEmit('cancelled', { sessionId, projectId: instance.projectId, reason });
    return true;
  }

  /** Drop queued (not yet started) messages for a session. Returns count dropped. */
  flushQueue(sessionId: string): number {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.items.length === 0) return 0;
    const dropped = queue.items.splice(0, queue.items.length);
    for (const item of dropped) {
      item.rejectStart(new Error('очередь сообщений сессии очищена'));
    }
    log.info({ sessionId, dropped: dropped.length }, 'session queue flushed');
    return dropped.length;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Cancel and kill EVERY tracked process, then clear all state. Idempotent
   * and time-bounded: called on bot exit / SIGINT / SIGTERM.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stoppingWatchdog?.();
    this.stoppingWatchdog = null;

    // 1) Cooperative abort for every in-flight run.
    for (const instance of this.processes.values()) {
      instance.abortController.abort('shutdown');
      instance.currentTask = null;
    }

    // 2) Reject everything still waiting for its turn.
    for (const queue of this.queues.values()) {
      const pending = queue.items.splice(0, queue.items.length);
      for (const item of pending) {
        item.rejectStart(new Error('ProcessManager is shutting down'));
      }
    }

    // 3) Wait (bounded) for in-flight runs to settle after the abort.
    const pendingRuns = [...this.activeRuns];
    if (pendingRuns.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingRuns),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
    }

    // 4) Escalate: SIGKILL anything that survived, then drop all state.
    for (const instance of this.processes.values()) {
      const pid = instance.pid;
      if (pid !== null) {
        try {
          killTree(pid, 'SIGKILL');
        } catch (err) {
          log.debug({ err, pid }, 'killTree failed during shutdown');
        }
      }
      instance.pid = null;
      instance.handle = null;
      instance.status = 'stopped';
    }

    this.processes.clear();
    this.queues.clear();
    this.activeRuns.clear();
    this.emitter.removeAllListeners();
    log.info('process manager shut down');
  }

  /**
   * Watchdog tick: kill runs with no activity for `timeoutMs` (hung-task
   * protection) and forget idle instances that are no longer running.
   * Returns the session ids that were flagged as hung.
   */
  reap(timeoutMs = DEFAULT_HANG_TIMEOUT_MS): string[] {
    const reaped: string[] = [];
    const idleGrace = Math.min(timeoutMs, IDLE_CLEANUP_MS);

    for (const instance of [...this.processes.values()]) {
      const sessionId = instance.sessionId;
      const queue = this.queues.get(sessionId);
      const busy = queue !== undefined && (queue.running || queue.items.length > 0);
      const age = now() - instance.lastActivityAt;

      if (busy && age > timeoutMs && instance.hangReason === null) {
        instance.hangReason = `задача зависла: нет активности более ${Math.round(timeoutMs / 60_000)} мин`;
        instance.abortController.abort('watchdog_timeout');
        const pid = instance.pid;
        if (pid !== null) {
          try {
            killTree(pid, 'SIGTERM');
          } catch (err) {
            log.debug({ err, pid, sessionId }, 'killTree failed during reap');
          }
        }
        instance.status = 'error';
        instance.currentTask = null;
        this.updateSessionStatus(sessionId, 'error');
        reaped.push(sessionId);
        log.warn({ sessionId, age }, 'reaped hung run');
      } else if (
        !busy &&
        instance.handle === null &&
        instance.status !== 'starting' &&
        instance.status !== 'running' &&
        age > idleGrace
      ) {
        this.processes.delete(sessionId);
        this.queues.delete(sessionId);
        log.debug({ sessionId }, 'cleaned up idle instance');
      }
    }

    return reaped;
  }

  /** Start the periodic watchdog. Returns a stop function (idempotent). */
  startWatchdog(intervalMs = 60_000, timeoutMs = DEFAULT_HANG_TIMEOUT_MS): () => void {
    this.stoppingWatchdog?.();
    const timer = setInterval(() => {
      try {
        this.reap(timeoutMs);
      } catch (err) {
        log.error({ err }, 'watchdog reap failed');
      }
    }, intervalMs);
    timer.unref();

    const stop = (): void => {
      clearInterval(timer);
      if (this.stoppingWatchdog === stop) this.stoppingWatchdog = null;
    };
    this.stoppingWatchdog = stop;
    return stop;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private pushLine(instance: ProcessInstance, line: BufferLine): void {
    instance.buffer.push(line);
    const overflow = instance.buffer.length - this.bufferLimit;
    if (overflow > 0) {
      instance.buffer.splice(0, overflow);
    }
  }

  private appendMessage(sessionId: string, role: 'user' | 'assistant', content: string): void {
    try {
      addMessage({ sessionId, role, content });
    } catch (err) {
      log.warn({ err, sessionId, role }, 'failed to persist chat message');
    }
  }

  private updateSessionStatus(sessionId: string, status: SessionStatus): void {
    try {
      updateSessionStatus(sessionId, status);
    } catch (err) {
      log.warn({ err, sessionId, status }, 'failed to update session status');
    }
  }

  /**
   * Best-effort pid discovery: some adapter status lines report the child pid
   * (`pid=1234`, `pid 1234`). Absent → null; pid tracking is opportunistic.
   */
  private static extractPid(progress: RunProgress): number | null {
    const candidates: string[] = [];
    if (progress.status) candidates.push(progress.status);
    if (progress.text) candidates.push(progress.text);
    for (const candidate of candidates) {
      const match = /(?:^|[^\p{L}])pid[=:\s]+(\d{2,7})\b/iu.exec(candidate);
      const captured = match?.[1];
      if (captured !== undefined) {
        const pid = Number.parseInt(captured, 10);
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
      }
    }
    return null;
  }

  /** `write src/index.ts` → `write: src/index.ts`; plain names pass through. */
  private static describeTool(tool: string | undefined): string | null {
    if (!tool) return null;
    const trimmed = tool.trim();
    if (trimmed.length === 0) return null;
    const match = /^([\p{L}\p{N}_.:-]+)\s+(.+)$/su.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return `${match[1]}: ${match[2]}`;
    }
    return trimmed;
  }
}
