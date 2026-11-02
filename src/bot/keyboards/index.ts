import { InlineKeyboard } from 'grammy';

/**
 * Callback data contract (must stay under Telegram's 64 byte limit).
 *
 * nav:main
 * projects:list | projects:new | projects:attach | projects:sel:<id> | projects:page:<n>
 * sessions:list | sessions:new | sessions:sel:<id> | sessions:rename:<id> |
 * sessions:end:<id> | sessions:hist:<id> | sessions:page:<n>
 * models:list | models:set:<provider/model> | models:page:<n>
 * settings:main | settings:auto:on | settings:auto:off | settings:revoke:<id>
 *          | settings:md:on | settings:md:off
 * files:list | files:page:<n> | files:cd:<i> | files:open:<i> | files:up |
 *          | files:zip
 * term:show | term:page:<n> | term:key:<name> | term:input
 * status:show
 * task:stop | task:refresh
 */

export const CB = {
  navMain: 'nav:main',

  projectsList: 'projects:list',
  projectsNew: 'projects:new',
  projectsAttach: 'projects:attach',
  projectsPage: (n: number) => `projects:page:${n}`,
  projectsSelect: (id: string) => `projects:sel:${id}`,

  sessionsList: 'sessions:list',
  sessionsNew: 'sessions:new',
  sessionsPage: (n: number) => `sessions:page:${n}`,
  sessionsSelect: (id: string) => `sessions:sel:${id}`,
  sessionsRename: (id: string) => `sessions:rename:${id}`,
  sessionsEnd: (id: string) => `sessions:end:${id}`,
  sessionsHistory: (id: string) => `sessions:hist:${id}`,

  modelsList: 'models:list',
  modelsPage: (n: number) => `models:page:${n}`,
  modelsSet: (modelId: string) => `models:set:${modelId}`,

  settingsMain: 'settings:main',
  settingsAutoOn: 'settings:auto:on',
  settingsAutoOff: 'settings:auto:off',
  settingsMdOn: 'settings:md:on',
  settingsMdOff: 'settings:md:off',

  filesList: 'files:list',
  filesPage: (n: number) => `files:page:${n}`,
  filesCd: (index: number) => `files:cd:${index}`,
  filesOpen: (index: number) => `files:open:${index}`,
  filesUp: 'files:up',
  filesZip: 'files:zip',

  termShow: 'term:show',
  termPage: (n: number) => `term:page:${n}`,
  termKey: (name: string) => `term:key:${name}`,
  termInput: 'term:input',

  statusShow: 'status:show',

  taskStop: 'task:stop',
  taskRefresh: 'task:refresh',
} as const;

/** Main menu shown by /start. */
export function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📁 Проекты', CB.projectsList)
    .text('💬 Сессии', CB.sessionsList)
    .row()
    .text('📂 Файлы', CB.filesList)
    .text('🤖 Модели', CB.modelsList)
    .row()
    .text('⚙️ Настройки', CB.settingsMain)
    .text('📟 Терминал', CB.termShow)
    .row()
    .text('📊 Статус', CB.statusShow);
}

export function backKeyboard(target: string = CB.navMain): InlineKeyboard {
  return new InlineKeyboard().text('⬅️ Назад', target);
}

/** Keyboard shown while a task is running. */
export function runningKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⛔ Остановить', CB.taskStop)
    .text('📟 Терминал', CB.termShow)
    .row()
    .text('🔄 Обновить', CB.taskRefresh);
}

export function completionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📟 Терминал', CB.termShow)
    .text('📊 Статус', CB.statusShow)
    .row()
    .text('🏠 Меню', CB.navMain);
}
