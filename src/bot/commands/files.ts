import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { getContainer } from '../../context.js';
import { CB } from '../keyboards/index.js';
import { paginate } from '../keyboards/menus.js';
import { escapeHtml } from '../../utils/html.js';
import { assertNoSymlinkEscape, assertPathInside, PathSecurityError } from '../../utils/paths.js';
import { buildZip, type ZipEntryInput } from '../../utils/zip.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('bot:files');

/** Entries per screen — leaves room for navigation rows inside Telegram's limits. */
const PAGE_SIZE = 6;

/** Telegram bots can upload documents up to 50 MB; stay safely below it. */
const MAX_FILE_BYTES = 48 * 1024 * 1024;

/** Refuse to even build an archive whose uncompressed payload is this big. */
const MAX_ZIP_SOURCE_BYTES = 150 * 1024 * 1024;

/** Refuse a finished archive above the Telegram upload limit. */
const MAX_ZIP_BYTES = 48 * 1024 * 1024;

/** Longest file name shown on a button. */
const MAX_LABEL = 34;

interface DirEntryView {
  name: string;
  isDir: boolean;
  size: number;
}

/**
 * Per-user navigation state for the file browser.
 *
 * Callback data is capped at 64 bytes, so the real paths live here and the
 * buttons only carry a short index into the CURRENT listing.
 */
interface FilesState {
  projectId: string;
  /** Absolute project root (never leaves the process). */
  root: string;
  /** Current folder relative to the root; '' means the root itself. */
  rel: string;
  entries: DirEntryView[];
}

const states = new Map<number, FilesState>();

export function clearFilesState(telegramId: number): void {
  states.delete(telegramId);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function shortLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name;
}

/** Reads and sorts one folder: directories first, then files, A→Z. */
async function listDir(abs: string): Promise<DirEntryView[]> {
  const dirents = await readdir(abs, { withFileTypes: true });
  const entries: DirEntryView[] = [];

  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue; // never follow links out of the project
    const isDir = dirent.isDirectory();
    let size = 0;
    if (!isDir && dirent.isFile()) {
      try {
        size = (await stat(path.join(abs, dirent.name))).size;
      } catch {
        continue; // vanished between readdir and stat
      }
    }
    entries.push({ name: dirent.name, isDir, size });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'en');
  });
  return entries;
}

/** Resolves the project the browser works in, or explains why it cannot. */
async function resolveProject(
  ctx: Context,
): Promise<{ projectId: string; root: string } | null> {
  const { messageRouter, projectManager } = getContainer();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return null;

  const projectId = messageRouter.resolveProjectId(telegramId);
  if (!projectId) {
    await reply(ctx, '⚠️ Сначала выберите проект на экране «📁 Проекты».');
    return null;
  }

  const project = await projectManager.get(projectId);
  if (!project) {
    messageRouter.clearActiveProject(telegramId);
    await reply(ctx, '⚠️ Проект не найден. Выберите проект заново.');
    return null;
  }

  try {
    await projectManager.assertUsable(project);
  } catch (error) {
    await reply(ctx, `⚠️ ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    return null;
  }

  return { projectId, root: project.path };
}

async function reply(ctx: Context, text: string): Promise<void> {
  await ctx
    .reply(text, { parse_mode: 'HTML' })
    .catch((error) => log.debug({ err: String(error) }, 'files reply failed'));
}

/** Shows the browser for the current folder (and remembers it per user). */
export async function showFiles(ctx: Context, page = 0): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const resolved = await resolveProject(ctx);
  if (!resolved) return;

  let state = states.get(telegramId);
  if (!state || state.projectId !== resolved.projectId || state.root !== resolved.root) {
    state = { projectId: resolved.projectId, root: resolved.root, rel: '', entries: [] };
    states.set(telegramId, state);
  }

  const abs = state.rel === '' ? state.root : path.join(state.root, state.rel);
  try {
    assertPathInside(state.root, abs);
    state.entries = await listDir(abs);
  } catch (error) {
    if (error instanceof PathSecurityError) {
      state.rel = '';
      await reply(ctx, '⚠️ Папка недоступна — вернулись в корень проекта.');
      return showFiles(ctx, 0);
    }
    await reply(ctx, `⚠️ Не удалось прочитать папку: ${escapeHtml(String(error))}`);
    return;
  }

  const { slice, page: p, pages } = paginate(state.entries, page);
  const relLabel = state.rel === '' ? '/' : state.rel.replaceAll('\\', '/');

  const lines = [
    '📂 <b>Файлы проекта</b>',
    '',
    `📁 Папка: <code>${escapeHtml(relLabel)}</code>`,
    `Всего записей: ${state.entries.length}`,
    '',
    'Нажмите файл, чтобы скачать его в чат.',
  ];

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const entry of slice) {
    const index = state.entries.indexOf(entry);
    if (entry.isDir) {
      keyboard.push([{ text: `📁 ${shortLabel(entry.name)}`, callback_data: CB.filesCd(index) }]);
    } else {
      keyboard.push([
        { text: `📄 ${shortLabel(entry.name)} · ${formatSize(entry.size)}`, callback_data: CB.filesOpen(index) },
      ]);
    }
  }

  if (slice.length === 0) {
    keyboard.push([{ text: 'Папка пуста', callback_data: 'noop' }]);
  }

  const pagerRow: Array<{ text: string; callback_data: string }> = [];
  if (p > 0) pagerRow.push({ text: '⬅️', callback_data: CB.filesPage(p - 1) });
  if (p < pages - 1) pagerRow.push({ text: '➡️', callback_data: CB.filesPage(p + 1) });
  if (pagerRow.length > 0) keyboard.push(pagerRow);

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (state.rel !== '') navRow.push({ text: '⬆️ Вверх', callback_data: CB.filesUp });
  navRow.push({ text: '📦 ZIP проекта', callback_data: CB.filesZip });
  keyboard.push(navRow);

  keyboard.push([
    { text: '⬅️ Проекты', callback_data: CB.projectsList },
    { text: '🏠 Меню', callback_data: CB.navMain },
  ]);

  const html = lines.join('\n');
  const markup = { inline_keyboard: keyboard };

  if (ctx.callbackQuery) {
    await ctx.editMessageText(html, { parse_mode: 'HTML', reply_markup: markup }).catch(async () => {
      await ctx.reply(html, { parse_mode: 'HTML', reply_markup: markup });
    });
    await ctx.answerCallbackQuery().catch(() => undefined);
  } else {
    await ctx.reply(html, { parse_mode: 'HTML', reply_markup: markup });
  }
}

/** Enters a subfolder by its index in the current listing. */
export async function enterDir(ctx: Context, index: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const state = states.get(telegramId);
  const entry = state?.entries[index];
  if (!state || !entry || !entry.isDir) {
    await ctx.answerCallbackQuery({ text: 'Папка не найдена — обновите список' }).catch(() => undefined);
    return showFiles(ctx);
  }

  const nextRel = state.rel === '' ? entry.name : `${state.rel}/${entry.name}`;
  const abs = path.join(state.root, nextRel);

  try {
    assertPathInside(state.root, abs);
    await assertNoSymlinkEscape(state.root, abs);
  } catch {
    await ctx.answerCallbackQuery({ text: '⛔ Недоступная папка' }).catch(() => undefined);
    return;
  }

  state.rel = nextRel;
  await showFiles(ctx, 0);
}

/** Moves one level up (stops at the project root). */
export async function goUp(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const state = states.get(telegramId);
  if (!state) return showFiles(ctx);

  if (state.rel !== '') {
    const parent = path.dirname(state.rel);
    state.rel = parent === '.' ? '' : parent;
  }
  await showFiles(ctx, 0);
}

/** Sends one file from the listing as a Telegram document. */
export async function sendFile(ctx: Context, index: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const state = states.get(telegramId);
  const entry = state?.entries[index];
  if (!state || !entry || entry.isDir) {
    await ctx.answerCallbackQuery({ text: 'Файл не найден — обновите список' }).catch(() => undefined);
    return showFiles(ctx);
  }

  await ctx.answerCallbackQuery({ text: 'Отправляю файл…' }).catch(() => undefined);

  const abs = path.join(state.root, state.rel, entry.name);
  try {
    assertPathInside(state.root, abs);
    await assertNoSymlinkEscape(state.root, abs);
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > MAX_FILE_BYTES) {
      await reply(
        ctx,
        `⚠️ Файл <b>${escapeHtml(entry.name)}</b> весит ${formatSize(info.size)} — Telegram не примет больше 48 МБ.`,
      );
      return;
    }
  } catch (error) {
    await reply(ctx, `⚠️ Файл недоступен: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    return;
  }

  try {
    await ctx.replyWithDocument(new InputFile(abs), {
      caption: `📄 <code>${escapeHtml(entry.name)}</code> · ${formatSize(entry.size)}`,
      parse_mode: 'HTML',
    });
  } catch (error) {
    log.warn({ err: String(error), file: entry.name }, 'send document failed');
    await reply(ctx, '⚠️ Не удалось отправить файл.');
  }
}

/** Thrown when the payload would not fit into a Telegram upload. */
class ArchiveTooBigError extends Error {}

/** Recursively collects every regular file (symlinks are skipped). */
async function collectFiles(root: string): Promise<ZipEntryInput[]> {
  const out: ZipEntryInput[] = [];
  let total = 0;

  const walk = async (dir: string, rel: string): Promise<void> => {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const abs = path.join(dir, dirent.name);
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;

      if (dirent.isDirectory()) {
        await walk(abs, childRel);
        continue;
      }
      if (!dirent.isFile()) continue;

      const info = await stat(abs);
      total += info.size;
      if (total > MAX_ZIP_SOURCE_BYTES) throw new ArchiveTooBigError();
      out.push({ name: childRel.replaceAll('\\', '/'), data: await readFile(abs), mtime: info.mtime });
    }
  };

  await walk(root, '');
  return out;
}

/** Builds the project ZIP and sends it as one document. */
export async function sendProjectZip(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const resolved = await resolveProject(ctx);
  if (!resolved) return;

  await ctx.answerCallbackQuery({ text: 'Собираю архив…' }).catch(() => undefined);

  const started = Date.now();
  try {
    const files = await collectFiles(resolved.root);
    if (files.length === 0) {
      await reply(ctx, '⚠️ В проекте нет файлов для архива.');
      return;
    }

    const zip = buildZip(files);
    if (zip.length > MAX_ZIP_BYTES) {
      await reply(
        ctx,
        `⚠️ Архив получился ${formatSize(zip.length)} — Telegram не примет больше 48 МБ.\n` +
          `Скачивайте нужные файлы по одному.`,
      );
      return;
    }

    const project = await getContainer().projectManager.get(resolved.projectId);
    const safeName = (project?.name ?? 'project').replace(/[^\w.-]+/gu, '_').slice(0, 40) || 'project';
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    await ctx.replyWithDocument(new InputFile(zip, `${safeName}.zip`), {
      caption:
        `📦 <b>${escapeHtml(project?.name ?? 'project')}</b>\n` +
        `Файлов: ${files.length} · ${formatSize(zip.length)} · за ${elapsed} с`,
      parse_mode: 'HTML',
    });
    log.info({ projectId: resolved.projectId, files: files.length, bytes: zip.length }, 'project zip sent');
  } catch (error) {
    if (error instanceof ArchiveTooBigError) {
      await reply(
        ctx,
        `⚠️ Проект больше ${formatSize(MAX_ZIP_SOURCE_BYTES)} — архив не собран, чтобы не занять память.\n` +
          `Скачивайте нужные файлы по одному.`,
      );
      return;
    }
    log.error({ err: String(error) }, 'project zip failed');
    await reply(ctx, `⚠️ Не удалось собрать архив: ${escapeHtml(String(error))}`);
  }
}
