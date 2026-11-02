import { loadConfig } from './config/env.js';
import { logger } from './utils/logger.js';
import { initDatabase, closeDatabase } from './database/client.js';
import { ProjectManager } from './projects/project-manager.js';
import { ProcessManager } from './cli/process-manager.js';
import { OpenCodeAdapter } from './cli/opencode-adapter.js';
import { ModelManager } from './cli/model-manager.js';
import { SessionManager } from './cli/session-manager.js';
import { MessageRouter } from './services/message-router.js';
import { TaskManager } from './services/task-manager.js';
import { TerminalSessionManager } from './cli/terminal-session-manager.js';
import { setContainer } from './context.js';
import { createBot } from './bot/index.js';
import { createBotSink } from './bot/api.js';
import { resolveBinary } from './cli/process-runner.js';

/**
 * RemoteCode boot sequence.
 *
 * Order matters: configuration is validated before anything is constructed, the
 * database is migrated before the container is built, and the OpenCode binary
 * is verified before the bot announces itself as Online. A bot that cannot
 * reach the CLI must fail loudly rather than pretend to work.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = logger.child({ module: 'boot' });

  log.info(
    {
      projectsRoot: config.projectsRoot,
      database: config.databaseUrl,
      logLevel: config.logLevel,
      authorizedUsers: config.authorizedUsers.length,
    },
    'starting RemoteCode',
  );

  if (config.opencodeArgs.includes('--auto')) {
    log.warn(
      'OPENCODE_ARGS contains --auto: OpenCode will auto-approve permissions. ' +
        'This gives the model the ability to run tools without asking. Enable it deliberately.',
    );
  }

  await initDatabase();
  log.info('database ready');

  // Verify the CLI is reachable before wiring everything up.
  const binary = resolveBinary(config.opencodeBinary);
  log.info({ binary }, 'opencode binary resolved');

  const opencodeAdapter = new OpenCodeAdapter();
  const modelManager = new ModelManager();
  const sessionManager = new SessionManager();
  const projectManager = new ProjectManager();
  const processManager = new ProcessManager();
  const messageRouter = new MessageRouter(projectManager, processManager);
  const taskManager = new TaskManager({
    processes: processManager,
    createSink: createBotSink,
  });
  const terminalSessions = new TerminalSessionManager();

  setContainer({
    projectManager,
    processManager,
    opencodeAdapter,
    modelManager,
    sessionManager,
    messageRouter,
    taskManager,
    terminalSessions,
  });

  // Hung-task protection: a run that produces nothing for 30 minutes is
  // reported and killed instead of blocking the session forever.
  const stopWatchdog = processManager.startWatchdog(30 * 60_000);

  const bot = createBot();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    stopWatchdog();
    try {
      taskManager.dispose();
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'task manager dispose failed');
    }
    try {
      // Kill Chat Mode children and Terminal Mode PTYs — no orphans may survive.
      await processManager.shutdown();
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'process shutdown failed');
    }
    try {
      const closed = terminalSessions.stopAll();
      if (closed > 0) log.info({ closed }, 'terminal sessions closed');
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'terminal shutdown failed');
    }
    try {
      bot.stop();
    } catch {
      // The bot may not be running yet.
    }
    closeDatabase();
    log.info('shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });

  log.info(
    { username: (await bot.api.getMe()).username },
    'RemoteCode online',
  );

  await bot.start({
    drop_pending_updates: true,
    onStart: (me) => log.info({ username: me.username }, `bot started as @${me.username}`),
  });
}

main().catch((error) => {
  logger.fatal(
    { err: error instanceof Error ? error.stack : String(error) },
    'fatal error during boot',
  );
  process.exit(1);
});
