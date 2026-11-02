import { ProjectManager } from './projects/project-manager.js';
import { ProcessManager } from './cli/process-manager.js';
import { OpenCodeAdapter } from './cli/opencode-adapter.js';
import { ModelManager } from './cli/model-manager.js';
import { SessionManager } from './cli/session-manager.js';
import { MessageRouter } from './services/message-router.js';
import { TaskManager } from './services/task-manager.js';
import { TerminalSessionManager } from './cli/terminal-session-manager.js';

/**
 * Composition root.
 *
 * Constructed once during boot in index.ts and read by the bot layer. Handlers
 * never construct services themselves, which keeps the wiring explicit and
 * makes the whole bot testable by swapping this container.
 */
export interface Container {
  projectManager: ProjectManager;
  processManager: ProcessManager;
  opencodeAdapter: OpenCodeAdapter;
  modelManager: ModelManager;
  sessionManager: SessionManager;
  messageRouter: MessageRouter;
  taskManager: TaskManager;
  /** Interactive TUI processes backing Terminal Mode. */
  terminalSessions: TerminalSessionManager;
}

let container: Container | null = null;

export function setContainer(next: Container): void {
  container = next;
}

export function getContainer(): Container {
  if (!container) {
    throw new Error('Container is not initialised — call setContainer() during boot first.');
  }
  return container;
}

export function hasContainer(): boolean {
  return container !== null;
}
