import { InlineKeyboard } from 'grammy';
import type { Project } from '../../types.js';
import { CB, backKeyboard } from './index.js';

/** Inline pagination keeps callback data short and messages editable. */
const PAGE_SIZE = 8;

export function paginate<T>(items: T[], page: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  return { slice: items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE), page: safePage, pages };
}

function pager(build: (n: number) => string, page: number, pages: number): InlineKeyboard {
  const k = new InlineKeyboard();
  if (page > 0) k.text('⬅️', build(page - 1));
  if (page < pages - 1) k.text('➡️', build(page + 1));
  return k;
}

export function projectsKeyboard(projects: Project[], page: number, activeId?: string): InlineKeyboard {
  const { slice, page: p, pages } = paginate(projects, page);
  const k = pager(CB.projectsPage, p, pages);

  for (const project of slice) {
    const marker = project.id === activeId ? '✅ ' : '';
    k.text(`${marker}${project.name}`, CB.projectsSelect(project.id)).row();
  }

  if (slice.length === 0) {
    k.text('Проектов пока нет', 'noop').row();
  }

  k.text('➕ Новый проект', CB.projectsNew).text('📂 Добавить директорию', CB.projectsAttach).row();
  k.text('⬅️ Меню', CB.navMain);
  return k;
}

export function projectActionsKeyboard(project: Project): InlineKeyboard {
  return new InlineKeyboard()
    .text('💬 Сессии', CB.sessionsList)
    .text('🗑 Удалить', `projects:del:${project.id}`)
    .row()
    .text('⬅️ Назад', CB.projectsList);
}

export function sessionsKeyboard(
  sessions: Array<{ id: string; name: string; status: string; model: string | null }>,
  page: number,
  activeId?: string | null,
): InlineKeyboard {
  const { slice, page: p, pages } = paginate(sessions, page);
  const k = pager(CB.sessionsPage, p, pages);

  for (const session of slice) {
    const marker = session.id === activeId ? '✅ ' : '';
    const dot = session.status === 'running' ? '🟢' : session.status === 'error' ? '🔴' : '⚪';
    k.text(`${marker}${dot} ${session.name}`, CB.sessionsSelect(session.id)).row();
  }

  if (slice.length === 0) {
    k.text('Сессий пока нет', 'noop').row();
  }

  k.text('➕ Новая сессия', CB.sessionsNew).row();
  k.text('⬅️ Проекты', CB.projectsList).text('🏠 Меню', CB.navMain);
  return k;
}

export function sessionActionsKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📝 Переименовать', CB.sessionsRename(sessionId))
    .text('📜 История', CB.sessionsHistory(sessionId))
    .row()
    .text('🤖 Модели', CB.modelsList)
    .text('⛔ Завершить', CB.sessionsEnd(sessionId))
    .row()
    .text('⬅️ Назад', CB.sessionsList);
}

export function modelsKeyboard(
  models: Array<{ id: string; display: string }>,
  page: number,
  activeModel: string | null,
): InlineKeyboard {
  const { slice, page: p, pages } = paginate(models, page);
  const k = pager(CB.modelsPage, p, pages);

  for (const model of slice) {
    const marker = model.id === activeModel ? '✅ ' : '';
    k.text(`${marker}${model.display}`, CB.modelsSet(model.id)).row();
  }

  if (slice.length === 0) k.text('Модели недоступны', 'noop').row();

  k.text('🔄 Обновить список', CB.modelsList).row();
  k.text('⬅️ Меню', CB.navMain);
  return k;
}

export function statusKeyboard(): InlineKeyboard {
  return backKeyboard(CB.navMain);
}
