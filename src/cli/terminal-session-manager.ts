import type { Project, Session, TerminalLine } from '../types.js';
import { PtyAdapter, KEYS, encodeLiteral } from './pty-adapter.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('terminal-sessions');

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
/** Hard ceiling so a forgotten terminal can never leak processes forever. */
const MAX_TERMINALS = 8;

export interface TerminalSessionInfo {
  sessionId: string;
  projectId: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
  exitCode: number | null;
  alive: boolean;
}

/**
 * Owns the interactive OpenCode TUI processes used by Terminal Mode.
 *
 * Deliberately separate from ProcessManager: Chat Mode drives `opencode run`
 * (one short-lived child per prompt), while Terminal Mode keeps a long-lived
 * PTY attached to the TUI. Mixing them would violate the "do not create a new
 * OpenCode instance per message" rule on one side and the "no interleaved
 * output" rule on the other.
 */
export class TerminalSessionManager {
  private readonly adapters = new Map<string, PtyAdapter>();
  private readonly meta = new Map<string, TerminalSessionInfo>();

  /** Returns the live PTY for a session, spawning it on first use. */
  ensure(session: Session, project: Project): PtyAdapter {
    const existing = this.adapters.get(session.id);
    if (existing && this.isAlive(session.id)) return existing;

    if (this.adapters.size >= MAX_TERMINALS) {
      // Evict the oldest terminal rather than growing without bound.
      const oldest = [...this.meta.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) {
        log.warn({ sessionId: oldest.sessionId }, 'terminal limit reached, evicting oldest');
        this.stop(oldest.sessionId);
      }
    }

    const adapter = new PtyAdapter({
      cwd: project.path,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      // Continue the stored native session when there is one, so Terminal Mode
      // opens the same conversation the Chat Mode has been using.
      extraArgs: session.opencodeSessionId ? ['-s', session.opencodeSessionId] : [],
    });

    this.meta.set(session.id, {
      sessionId: session.id,
      projectId: project.id,
      cwd: project.path,
      pid: adapter.pid,
      startedAt: Date.now(),
      exitCode: null,
      alive: true,
    });

    adapter.onExit((code, signal) => {
      const info = this.meta.get(session.id);
      if (info) {
        info.alive = false;
        info.exitCode = code;
        info.pid = null;
      }
      this.adapters.delete(session.id);
      log.info({ sessionId: session.id, code, signal }, 'terminal process exited');
    });

    this.adapters.set(session.id, adapter);
    log.info({ sessionId: session.id, cwd: project.path }, 'terminal spawned');
    return adapter;
  }

  isRunning(sessionId: string): boolean {
    return this.adapters.has(sessionId) && this.isAlive(sessionId);
  }

  /** Last rendered rows of the virtual screen, ANSI-free. */
  terminalLines(sessionId: string, lastN = 200): string[] {
    const adapter = this.adapters.get(sessionId);
    if (!adapter) return [];
    try {
      const rendered = adapter.screen.render();
      return rendered.slice(Math.max(0, rendered.length - lastN));
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'screen render failed');
      return [];
    }
  }

  /** Coloured rows, for a richer preview. */
  terminalLinesAnsi(sessionId: string, lastN = 200): string[] {
    const adapter = this.adapters.get(sessionId);
    if (!adapter) return [];
    const rendered = adapter.screen.renderAnsi();
    return rendered.slice(Math.max(0, rendered.length - lastN));
  }

  cursor(sessionId: string): { row: number; col: number; visible: boolean } | null {
    return this.adapters.get(sessionId)?.screen.cursor() ?? null;
  }

  toTerminalLines(sessionId: string, lastN = 100): TerminalLine[] {
    const adapter = this.adapters.get(sessionId);
    if (!adapter) return [];
    return adapter.screen.toTerminalLines(lastN);
  }

  /** Sends a curated special key. Returns false when no terminal is running. */
  async sendKey(sessionId: string, key: string): Promise<boolean> {
    const adapter = this.adapters.get(sessionId);
    if (!adapter || !this.isAlive(sessionId)) return false;

    const sequence = (KEYS as Record<string, string>)[key.toLowerCase()];
    if (sequence === undefined) {
      log.warn({ key }, 'rejected unknown terminal key');
      return false;
    }

    adapter.write(sequence);
    log.debug({ sessionId, key }, 'terminal key sent');
    return true;
  }

  /** Sends a plain line, converting LF to CR so the TUI submits it once. */
  async sendText(sessionId: string, text: string): Promise<boolean> {
    const adapter = this.adapters.get(sessionId);
    if (!adapter || !this.isAlive(sessionId)) return false;

    adapter.write(encodeLiteral(text));
    log.debug({ sessionId, length: text.length }, 'terminal text sent');
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const adapter = this.adapters.get(sessionId);
    if (!adapter) return;
    adapter.resize(cols, rows);
  }

  stop(sessionId: string): boolean {
    const adapter = this.adapters.get(sessionId);
    if (!adapter) return false;

    this.adapters.delete(sessionId);
    this.meta.delete(sessionId);
    try {
      adapter.dispose();
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'terminal dispose failed');
    }
    log.info({ sessionId }, 'terminal stopped');
    return true;
  }

  /** Called on shutdown so no PTY survives the bot. */
  stopAll(): number {
    const ids = [...this.adapters.keys()];
    for (const id of ids) this.stop(id);
    return ids.length;
  }

  info(sessionId: string): TerminalSessionInfo | undefined {
    return this.meta.get(sessionId);
  }

  list(): TerminalSessionInfo[] {
    return [...this.meta.values()];
  }

  private isAlive(sessionId: string): boolean {
    return this.meta.get(sessionId)?.alive !== false;
  }
}
