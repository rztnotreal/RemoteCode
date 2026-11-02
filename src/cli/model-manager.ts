/**
 * Model management backed by the REAL CLI.
 *
 * The list comes from `opencode models`, so RemoteCode never invents or
 * hardcodes model names: whatever the installed OpenCode can use is what the
 * Telegram menu shows. Switching a model is persisted on the RemoteCode session
 * and applied on the next `opencode run -m <model> -s <same session id>`, which
 * is how OpenCode itself keeps the conversation context across a model change.
 */

import type { ModelInfo } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { ProcessTimeoutError, runProcess } from './process-runner.js';

const log = createLogger('model-manager');

/** How long `opencode models` may take before it is declared hung. */
const LIST_TIMEOUT_MS = 30_000;

/** Cached list lifetime; keeps the Telegram menu responsive without a CLI call on every render. */
const DEFAULT_TTL_MS = 60_000;

/** `provider/model`, optionally with a `#variant` suffix. */
const MODEL_PATTERN = /^([A-Za-z0-9][\w.~-]*)\/([^/\s]+)$/u;

/** Trailing characters kept for human-readable error messages. */
const STDERR_TAIL = 1_000;

export interface ListOptions {
  /** Bypass the cache. */
  refresh?: boolean;
}

export class ModelManager {
  private cache: { models: ModelInfo[]; at: number } | null = null;

  /** In-flight list call, so concurrent menu renders share ONE CLI process. */
  private inflight: Promise<ModelInfo[]> | null = null;

  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  }

  /**
   * Available models, parsed from `opencode models`.
   * Throws a descriptive error when the CLI fails or hangs; the caller decides
   * how to present it (the models screen shows the error instead of a list).
   */
  async list(options: ListOptions = {}): Promise<ModelInfo[]> {
    const fresh = this.cache;
    if (!options.refresh && fresh !== null && Date.now() - fresh.at <= this.ttlMs) {
      return fresh.models;
    }

    if (this.inflight !== null) return this.inflight;

    const promise = this.fetch().then(
      (models) => {
        this.cache = { models, at: Date.now() };
        this.inflight = null;
        return models;
      },
      (error: unknown) => {
        this.inflight = null;
        throw error;
      },
    );
    this.inflight = promise;
    return promise;
  }

  /** Forces the next `list()` to call the CLI again. */
  refresh(): void {
    this.cache = null;
  }

  /**
   * Looks a model id up in the real list and returns its record.
   * Throws when the id is unknown — selection is validated, never assumed.
   */
  async resolve(modelId: string, options: ListOptions = {}): Promise<ModelInfo> {
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    const models = await this.list(options);
    const found = models.find((model) => model.id === id);
    if (found === undefined) {
      throw new Error(`unknown model "${id}" — pick one from the list`);
    }
    return found;
  }

  /** True when `modelId` is one the CLI actually offers (cached lookup). */
  async has(modelId: string): Promise<boolean> {
    try {
      await this.resolve(modelId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Human-readable label for a model id.
   * `opencode/mimo-v2.6-flash-free` → `mimo v2.6 flash free · opencode`.
   * Unknown/unparseable ids pass through unchanged so nothing is ever hidden.
   */
  formatDisplay(modelId: string): string {
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    if (id.length === 0) return 'по умолчанию';

    const match = MODEL_PATTERN.exec(id);
    if (match === null) return id;

    const provider = match[1] ?? '';
    const model = match[2] ?? '';
    const pretty = model
      .split('#')[0]!
      .replace(/[-_]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (pretty.length === 0) return id;
    return `${pretty} · ${provider}`;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async fetch(): Promise<ModelInfo[]> {
    const result = await runProcess({
      cwd: process.cwd(),
      args: ['models'],
      timeoutMs: LIST_TIMEOUT_MS,
    });

    if (result.timedOut) {
      throw new ProcessTimeoutError(
        `opencode models не ответил за ${LIST_TIMEOUT_MS} мс — проверьте установку CLI`,
        LIST_TIMEOUT_MS,
      );
    }

    if (result.code !== 0) {
      const tail = result.stderr.trim().slice(-STDERR_TAIL);
      throw new Error(
        `opencode models завершился с кодом ${result.code === null ? '?' : result.code}` +
          (tail.length > 0 ? `: ${tail}` : ''),
      );
    }

    const models = ModelManager.parse(result.stdout);
    log.debug({ count: models.length }, 'models listed');
    return models;
  }

  /** Parses the line-per-model output of `opencode models`. */
  static parse(stdout: string): ModelInfo[] {
    const models: ModelInfo[] = [];
    const seen = new Set<string>();

    for (const rawLine of String(stdout ?? '').split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const match = MODEL_PATTERN.exec(line);
      if (match === null) continue; // headers/notes are not models

      const provider = match[1]!;
      const name = match[2]!;
      const id = `${provider}/${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({ id, provider, name });
    }

    return models;
  }
}
