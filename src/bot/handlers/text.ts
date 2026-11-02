import type { Context } from 'grammy';
import { getContainer } from '../../context.js';
import { getPending, clearPending } from '../commands/projects.js';
import { showProjects } from '../commands/projects.js';
import { createSession, renameSession } from '../commands/sessions.js';
import { showTerminal } from '../commands/terminal.js';
import { escapeHtml } from '../../utils/html.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('bot:text');

/**
 * Single entry point for ordinary Telegram messages.
 *
 * Order matters:
 *   1. a pending multi-step flow consumes the text (so a project name or a
 *      terminal line is never mistaken for a prompt);
 *   2. explicit slash commands;
 *   3. everything else is routed to OpenCode as ONE prompt.
 */
export async function handleText(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const pending = getPending(telegramId);
  if (pending) {
    clearPending(telegramId);
    await handlePending(ctx, pending, text.trim());
    return;
  }

  if (text.startsWith('/')) {
    await handleSlash(ctx, text);
    return;
  }

  await routeToOpenCode(ctx, text);
}

async function handlePending(
  ctx: Context,
  pending: NonNullable<ReturnType<typeof getPending>>,
  value: string,
): Promise<void> {
  if (!value) {
    await ctx.reply('Пустой ввод. Попробуйте ещё раз или отправьте /cancel.');
    return;
  }

  const { projectManager } = getContainer();

  switch (pending.kind) {
    case 'project:new': {
      try {
        const project = await projectManager.create(value);
        await ctx.reply(`✅ Проект <b>${escapeHtml(project.name)}</b> создан:\n<code>${escapeHtml(project.path)}</code>`, {
          parse_mode: 'HTML',
        });
        await showProjects(ctx);
      } catch (error) {
        await ctx.reply(`⚠️ ${escapeHtml(errorMessage(error))}`, { parse_mode: 'HTML' });
      }
      return;
    }

    case 'project:attach': {
      try {
        // The name is derived from the directory's base name; the user only
        // supplies the path, so we never ask for the same information twice.
        const name = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
        const project = await projectManager.attach(name, value);
        await ctx.reply(`✅ Директория подключена: <b>${escapeHtml(project.name)}</b>`, { parse_mode: 'HTML' });
        await showProjects(ctx);
      } catch (error) {
        await ctx.reply(`⚠️ ${escapeHtml(errorMessage(error))}`, { parse_mode: 'HTML' });
      }
      return;
    }

    case 'session:new': {
      await createSession(ctx, pending.projectId, value);
      return;
    }

    case 'session:rename': {
      await renameSession(ctx, pending.sessionId, value);
      return;
    }

    case 'terminal:input': {
      const { messageRouter, terminalSessions } = getContainer();
      const session = await messageRouter.activeSession(telegramIdOf(ctx));
      if (!session) {
        await ctx.reply('Нет активной сессии.');
        return;
      }
      const sent = await terminalSessions.sendText(session.id, value);
      await ctx.reply(sent ? '⌨️ Строка отправлена в терминал.' : '⚠️ Сначала запустите терминал кнопкой «▶️ Запустить».');
      await showTerminal(ctx);
      return;
    }
  }
}

/**
 * Commands that MessageRouter already implements inline (with validation).
 * They are delegated so there is exactly one implementation of each rule.
 */
const ROUTER_COMMANDS = new Set(['/rename', '/model', '/stop', '/history', '/terminal']);

async function handleSlash(ctx: Context, text: string): Promise<void> {
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = (rawCommand ?? '').split('@')[0] ?? '';
  const arg = rest.join(' ').trim();
  const { messageRouter } = getContainer();
  const telegramId = telegramIdOf(ctx);

  // Chat commands with built-in validation live in the router.
  if (ROUTER_COMMANDS.has(command)) {
    const outcome = await messageRouter.route(telegramId, text);
    switch (outcome.kind) {
      case 'command':
        await ctx.reply(escapeHtml(outcome.reply), { parse_mode: 'HTML' });
        return;
      case 'no_session':
        await ctx.reply('💬 Активная сессия не выбрана. Сначала выберите проект и сессию.');
        return;
      case 'not_authorized':
        await ctx.reply('⛔ Доступ запрещён.');
        return;
      case 'error':
        await ctx.reply(`⚠️ ${escapeHtml(outcome.message)}`, { parse_mode: 'HTML' });
        return;
      default:
        await ctx.reply('⚠️ Неожиданный ответ роутера.');
        return;
    }
  }

  switch (command) {
    case '/cancel':
      clearPending(telegramId);
      await ctx.reply('✋ Действие отменено.');
      return;

    case '/status': {
      const session = await messageRouter.activeSession(telegramId);
      await ctx.reply(
        session
          ? await messageRouter.summarizeStatus(session.id)
          : 'Активная сессия не выбрана. Процесс OpenCode не запущен.',
      );
      return;
    }

    case '/newsession': {
      const { requestSessionCreate } = await import('../commands/sessions.js');
      await requestSessionCreate(ctx);
      return;
    }

    case '/models':
    case '/model': {
      const { showModels } = await import('../commands/models.js');
      if (!arg) {
        await showModels(ctx);
        return;
      }
      const { selectModel } = await import('../commands/models.js');
      await selectModel(ctx, arg);
      return;
    }

    case '/projects': {
      const { showProjects } = await import('../commands/projects.js');
      await showProjects(ctx);
      return;
    }

    case '/terminal': {
      await showTerminal(ctx);
      return;
    }

    default:
      await ctx.reply(
        'Неизвестная команда.\n\n' +
          'Доступны: /projects /newsession /status /model /models /history /terminal /stop /rename /cancel',
      );
  }
}

/**
 * The core of Chat Mode.
 *
 * The ENTIRE message — including all newlines — is passed to OpenCode as a
 * single prompt, so a multi-line message can never be misinterpreted as several
 * independent prompts.
 *
 * TaskManager owns the status card: it is started before the run and then
 * listens to ProcessManager events, so the card is updated live and the final
 * answer (of any length) is delivered without truncation.
 */
async function routeToOpenCode(ctx: Context, text: string): Promise<void> {
  const { messageRouter, taskManager, projectManager } = getContainer();
  const telegramId = telegramIdOf(ctx);
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  // Everything is validated BEFORE a status card exists, so a rejected message
  // never leaves a stale "in progress" card behind.
  const session = await messageRouter.activeSession(telegramId);
  if (!session) {
    await ctx.reply('💬 <b>Активная сессия не выбрана</b>\n\nСначала выберите проект → создайте сессию → выберите её.', {
      parse_mode: 'HTML',
    });
    return;
  }

  const project = await projectManager.get(session.projectId);
  if (!project) {
    await ctx.reply('⚠️ Проект сессии не найден в базе. Переподключите каталог проекта.', { parse_mode: 'HTML' });
    return;
  }

  try {
    await projectManager.assertUsable(project);
  } catch (error) {
    await ctx.reply(`⚠️ ${escapeHtml(errorMessage(error))}`, { parse_mode: 'HTML' });
    return;
  }

  const statusMessage = await ctx.reply('⏳ OpenCode выполняет задачу…');

  await taskManager.start({
    telegramId,
    chatId,
    messageId: statusMessage.message_id,
    session,
    project,
  });

  const outcome = await messageRouter.route(telegramId, text);

  // 'routed' needs no work here: TaskManager already rendered the result from
  // the ProcessManager 'finished' event.
  if (outcome.kind === 'routed') return;

  // No run happened — stop tracking so the card does not sit there forever.
  taskManager.abandon(session.id);

  const card = (body: string): Promise<unknown> =>
    ctx.api
      .editMessageText(chatId, statusMessage.message_id, body, { parse_mode: 'HTML' })
      .catch((error) => {
        log.debug({ err: String(error) }, 'status card edit skipped');
        return undefined;
      });

  switch (outcome.kind) {
    case 'not_authorized':
      await card('⛔ Доступ запрещён.');
      return;

    case 'no_session':
      await card('💬 Активная сессия не выбрана.\n\nСначала выберите проект → создайте сессию → выберите её.');
      return;

    case 'project_missing':
      await card(`⚠️ ${escapeHtml(outcome.message)}`);
      return;

    case 'command':
      await card(escapeHtml(outcome.reply));
      return;

    case 'error':
      await card(`⚠️ <b>Ошибка</b>\n\n${escapeHtml(outcome.message)}`);
      return;

    default:
      log.warn({ outcome }, 'unknown route outcome');
  }
}

function telegramIdOf(ctx: Context): number {
  const id = ctx.from?.id;
  if (id === undefined) throw new Error('Update carries no user id');
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
