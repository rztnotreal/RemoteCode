/**
 * Recovery/inspection of REAL OpenCode sessions through the official CLI.
 *
 * RemoteCode distinguishes three identities (see the spec):
 *   1. its own session row (`sessions.id`),
 *   2. the OS process (pid — never reused after a restart),
 *   3. the native OpenCode session (`sessions.opencode_session_id`, `ses_…`).
 *
 * After a RemoteCode restart the stored pid is meaningless, so recovery goes
 * exclusively through `opencode session list / export / delete` in the PROJECT
 * directory. When the CLI no longer knows the stored id, `verifyContext()`
 * reports it explicitly (`missing`) instead of letting the caller pretend the
 * conversation context survived.
 */

import { createLogger } from '../utils/logger.js';
import { runProcess } from './process-runner.js';

const log = createLogger('session-manager');

/** Default deadline for each CLI session call. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Cap for transcript history returned to the bot. */
const HISTORY_LIMIT = 200;

/** Trailing stderr characters used in error messages. */
const STDERR_TAIL = 1_000;

/** One session as reported by `opencode session list --format json`. */
export interface RemoteSession {
  id: string;
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** A transcript entry mapped to RemoteCode roles. */
export interface HistoryEntry {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/** The parts of `opencode session export` that RemoteCode relies on. */
export interface ExportedSession {
  id: string;
  title: string | null;
  /** Project directory the session belongs to (`info.location.directory`). */
  directory: string | null;
  /** `provider/model` when the CLI reports one. */
  model: string | null;
  messages: HistoryEntry[];
}

/**
 * Outcome of checking a stored native session id after a restart:
 *  - `ok`          — the session exists (and belongs to the expected directory),
 *  - `missing`     — the CLI does not know it: context CANNOT be restored,
 *  - `mismatch`    — the session exists but lives in another directory,
 *  - `unavailable` — the CLI could not be queried (unknown, do not destroy data).
 */
export type ContextCheck = 'ok' | 'missing' | 'mismatch' | 'unavailable';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Normalises a path for case-insensitive comparison on Windows. */
function normalizePath(value: string): string {
  const resolved = value.replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface SessionManagerOptions {
  timeoutMs?: number;
}

export class SessionManager {
  private readonly timeoutMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * Lists the sessions OpenCode knows for the project at `cwd`.
   * Throws on CLI failure so callers can distinguish "none" from "unknown".
   */
  async listRemote(cwd: string, options: { timeoutMs?: number } = {}): Promise<RemoteSession[]> {
    const result = await runProcess({
      cwd,
      args: ['session', 'list', '--format', 'json'],
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });

    if (result.timedOut) {
      throw new Error(`opencode session list не ответил за ${this.timeoutMs} мс`);
    }
    if (result.code !== 0) {
      const tail = result.stderr.trim().slice(-STDERR_TAIL);
      throw new Error(
        `opencode session list завершился с кодом ${result.code ?? '?'}` +
          (tail.length > 0 ? `: ${tail}` : ''),
      );
    }

    const parsed = SessionManager.parseJson(result.stdout);
    if (!Array.isArray(parsed)) {
      throw new Error('opencode session list вернул неожиданный формат (ожидался JSON-массив)');
    }

    const sessions: RemoteSession[] = [];
    for (const entry of parsed) {
      const record = asRecord(entry);
      if (record === null) continue;
      const id = typeof record.id === 'string' ? record.id : null;
      if (id === null || id.length === 0) continue;
      sessions.push({
        id,
        title: typeof record.title === 'string' && record.title.length > 0 ? record.title : null,
        createdAt: typeof record.created === 'number' ? record.created : null,
        updatedAt: typeof record.updated === 'number' ? record.updated : null,
      });
    }
    return sessions;
  }

  /** True when the CLI confirms the native session id exists in `cwd`. */
  async sessionExists(cwd: string, opencodeSessionId: string): Promise<boolean> {
    if (!opencodeSessionId) return false;
    const sessions = await this.listRemote(cwd);
    return sessions.some((session) => session.id === opencodeSessionId);
  }

  /** Full transcript of one session, or null when it cannot be read. */
  async exportRemote(cwd: string, opencodeSessionId: string): Promise<ExportedSession | null> {
    if (!opencodeSessionId) return null;

    const result = await runProcess({
      cwd,
      args: ['session', 'export', opencodeSessionId],
      timeoutMs: this.timeoutMs,
    });

    if (result.timedOut) {
      log.warn({ opencodeSessionId }, 'session export timed out');
      return null;
    }
    if (result.code !== 0) {
      log.debug(
        { opencodeSessionId, code: result.code, stderr: result.stderr.slice(-STDERR_TAIL) },
        'session export failed',
      );
      return null;
    }

    const parsed = SessionManager.parseJson(result.stdout);
    const record = asRecord(parsed);
    if (record === null) return null;

    const info = asRecord(record.info) ?? {};
    const rawMessages = Array.isArray(record.messages) ? record.messages : [];

    const infoModel = asRecord(info.model);
    const model =
      infoModel !== null &&
      typeof infoModel.providerID === 'string' &&
      infoModel.providerID.length > 0 &&
      typeof infoModel.id === 'string' &&
      infoModel.id.length > 0
        ? `${infoModel.providerID}/${infoModel.id}`
        : null;

    const location = asRecord(info.location);
    const directory = typeof location?.directory === 'string' ? location.directory : null;

    const messages: HistoryEntry[] = [];
    for (const raw of rawMessages) {
      const message = asRecord(raw);
      if (message === null) continue;
      const entry = SessionManager.mapMessage(message);
      if (entry !== null) messages.push(entry);
      if (messages.length >= HISTORY_LIMIT) break;
    }

    return {
      id: typeof info.id === 'string' ? info.id : opencodeSessionId,
      title: typeof info.title === 'string' && info.title.length > 0 ? info.title : null,
      directory,
      model,
      messages,
    };
  }

  /**
   * Transcript for the bot's history view. Returns entries even when only the
   * local cache exists? No — this reads the CLI only; callers fall back to the
   * local `messages` table themselves.
   */
  async history(cwd: string, opencodeSessionId: string): Promise<HistoryEntry[]> {
    const exported = await this.exportRemote(cwd, opencodeSessionId);
    return exported?.messages ?? [];
  }

  /**
   * Verifies that a stored native session id can still be resumed, and that it
   * belongs to the given project directory. Never invents a result: an
   * unreachable CLI yields `unavailable`, which callers must treat as "do not
   * destroy the stored id".
   */
  async verifyContext(
    cwd: string,
    opencodeSessionId: string,
    expectedDirectory?: string,
  ): Promise<ContextCheck> {
    if (!opencodeSessionId) return 'missing';

    try {
      const sessions = await this.listRemote(cwd);
      if (!sessions.some((session) => session.id === opencodeSessionId)) {
        return 'missing';
      }
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'session verification unavailable',
      );
      return 'unavailable';
    }

    if (expectedDirectory === undefined) return 'ok';

    try {
      const exported = await this.exportRemote(cwd, opencodeSessionId);
      if (exported?.directory) {
        if (normalizePath(exported.directory) !== normalizePath(expectedDirectory)) {
          log.warn(
            { opencodeSessionId, expected: expectedDirectory, actual: exported.directory },
            'session belongs to another directory',
          );
          return 'mismatch';
        }
      }
      return 'ok';
    } catch {
      // Existence is already proven; a failed directory read must not block use.
      return 'ok';
    }
  }

  /** Deletes a native session. True when the CLI confirms deletion. */
  async deleteRemote(cwd: string, opencodeSessionId: string): Promise<boolean> {
    if (!opencodeSessionId) return false;
    const result = await runProcess({
      cwd,
      args: ['session', 'delete', opencodeSessionId],
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0) {
      log.debug({ opencodeSessionId, code: result.code }, 'session delete failed');
      return false;
    }
    log.info({ opencodeSessionId }, 'native opencode session deleted');
    return true;
  }

  // ── parsing helpers ───────────────────────────────────────────────────────

  /** Parses JSON tolerating leading/trailing log noise around the payload. */
  private static parseJson(stdout: string): unknown {
    const text = String(stdout ?? '').trim();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Recover the first balanced JSON value (arrays/objects) in the output.
      const start = text.search(/[[{]/u);
      if (start < 0) return null;
      const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (end <= start) return null;
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }

  /**
   * Maps one exported message onto a RemoteCode role.
   *  - `type: "user"`      → its `text` (the prompt, possibly quoted)
   *  - `type: "assistant"` → concatenated `content[].type === "text"` parts
   *  - tool/idle/… entries → skipped (they are not conversation turns)
   */
  private static mapMessage(message: Record<string, unknown>): HistoryEntry | null {
    const type = typeof message.type === 'string' ? message.type : null;

    if (type === 'user') {
      const text = SessionManager.cleanPrompt(message.text);
      return text.length > 0 ? { role: 'user', text } : null;
    }

    if (type === 'assistant') {
      const parts = Array.isArray(message.content) ? message.content : [];
      const chunks: string[] = [];
      for (const part of parts) {
        const record = asRecord(part);
        if (record === null) continue;
        if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
          chunks.push(record.text);
        }
      }
      if (chunks.length === 0 && typeof message.text === 'string') {
        chunks.push(message.text);
      }
      const text = chunks.join('\n\n').trim();
      return text.length > 0 ? { role: 'assistant', text } : null;
    }

    if (type === 'system') {
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      return text.length > 0 ? { role: 'system', text } : null;
    }

    return null;
  }

  /** Strips the surrounding quotes the CLI puts around stored prompts. */
  private static cleanPrompt(value: unknown): string {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }
}
