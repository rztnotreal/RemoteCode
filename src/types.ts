/**
 * Shared type contracts for RemoteCode.
 *
 * Every module in the project imports its cross-module types from here so that
 * independently developed layers (bot / cli / services / database) stay in sync.
 */

/** A project is a directory on disk that OpenCode runs inside of. */
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

/** Lifecycle of a RemoteCode session (not of the OS process). */
export type SessionStatus = 'idle' | 'starting' | 'running' | 'error' | 'stopped';

/** A session maps to exactly one OpenCode session id. */
export interface Session {
  id: string;
  projectId: string;
  /** Native OpenCode session id, e.g. `ses_...`. Null until OpenCode creates it. */
  opencodeSessionId: string | null;
  name: string;
  /** Model in `provider/model` form. Null = use OpenCode default. */
  model: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

/** A single chat message persisted for history/recovery. */
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

/** Live state of a running OpenCode child process. */
export interface ProcessSnapshot {
  sessionId: string;
  projectId: string;
  cwd: string;
  /** OS pid of the CLI child process. Null when nothing is running. */
  pid: number | null;
  model: string | null;
  status: SessionStatus;
  /** Unix ms of the last observed activity. */
  lastActivityAt: number;
  /** Unix ms when the current process was spawned. */
  startedAt: number | null;
  /** Human readable description of the current operation, if any. */
  currentTask: string | null;
}

/** A model advertised by `opencode models`. */
export interface ModelInfo {
  /** `provider/model` as printed by the CLI. */
  id: string;
  provider: string;
  name: string;
}

/** One parsed line of the virtual terminal screen (Terminal Mode). */
export interface TerminalLine {
  text: string;
  /** True when the line is currently highlighted/selected in the TUI. */
  active: boolean;
}

/** Result of a single prompt sent to OpenCode. */
export interface RunResult {
  sessionId: string;
  /** The OpenCode session id, which may differ from the input on first run. */
  opencodeSessionId: string | null;
  /** Full assistant text accumulated for this prompt. */
  text: string;
  /** Tools invoked while producing the answer, in order. */
  tools: string[];
  /** True when the CLI exited cleanly. */
  ok: boolean;
  /** Process exit code, when known. */
  exitCode: number | null;
  /** Populated when `ok` is false. */
  error: string | null;
  /** True when the run was cancelled by the user. */
  cancelled: boolean;
}

/** Progress callback payload emitted while a prompt is running. */
export interface RunProgress {
  kind: 'text' | 'tool' | 'status' | 'session';
  text?: string;
  tool?: string;
  status?: string;
  opencodeSessionId?: string;
}

/** Streaming handle for an in-flight prompt. */
export interface RunHandle {
  /** Resolves when the run finishes for any reason. */
  done: Promise<RunResult>;
  /** Requests cooperative cancellation. */
  cancel(reason?: string): void;
}
