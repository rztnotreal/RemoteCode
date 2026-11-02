# RemoteCode

Telegram-интерфейс для удалённого управления **локальным OpenCode CLI**.

RemoteCode — это не чат-бот, который ходит к AI-провайдерам сам. Это удалённый
контроллер настоящего установленного OpenCode: все задачи выполняются через
процесс CLI в выбранной рабочей директории.

```
Telegram → RemoteCode → CLI Process → OpenCode → CLI Output → RemoteCode → Telegram
```

---

## Ключевое решение по интеграции

Проверено на установленном **OpenCode v2.2.5** (см. раздел «Исследование CLI»).

Основной механизм — **не** SDK и **не** HTTP API, а запуск реального
исполняемого файла CLI как дочернего процесса:

```bash
opencode run --format json -s ses_XXXX -m provider/model "промпт"
```

`--format json` отдаёт NDJSON-поток событий (`step_start`, `text`,
`tool_use`, `step_finish`). Это даёт то, что требует ТЗ:

* **реальный сигнал завершения** — выход процесса с кодом `0`, а не таймер;
  таймер используется только как защита от зависания;
* **реальный идентификатор сессии** — `sessionID` присутствует в каждом
  событии и сохраняется в БД;
* **восстановление контекста** — повторный запуск с `-s <sessionID>`
  продолжает ту же сессию OpenCode (проверено экспериментально);
* **смена модели с сохранением контекста** — тот же `-s` плюс другой `-m`.

Флаг `--auto` в установленной версии **поддерживается** (`--auto  Auto-approve
permissions that are not explicitly denied`), поэтому эквивалентное поведение
реализовано именно им, и он заведён за отдельный переключатель настройки.

### Режимы

| Режим | Механизм | Приоритет |
|---|---|---|
| **Chat Mode** | `opencode run --format json` (child process + NDJSON) | MVP, основной |
| **Terminal Mode** | `node-pty` + виртуальный VT-экран | вторичный |

---

## Установка

### Общее

```bash
npm install
npm run build
```

Требуется установленный OpenCode CLI:

```bash
opencode --version    # ожидается v2.x
```

> **Windows.** npm ставит `.ps1`/`.cmd`-обёртки: `.ps1` блокируется политикой
> PowerShell, а `.cmd` вообще **нельзя** запустить через `spawn` без оболочки
> (Node отдаёт `EINVAL`, CVE-2024-27980). RemoteCode поэтому парсит сам шим
> (`resolveInvocation` в `process-runner.ts`) и запускает **настоящий
> исполняемый файл напрямую** — например
> `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe` — минуя
> `cmd.exe` и любую оболочку. Путь можно задать и вручную через
> `OPENCODE_BINARY`.

> **node-pty** требует инструментария сборки нативных модулей: на Windows —
> Visual Studio Build Tools с «Desktop development with C++», на Linux —
> `build-essential` и `python3`. Если node-pty не собрался, Chat Mode
> продолжит работать, а Terminal Mode сообщит об ошибке и корректно
> отключится — бот при этом не падает.

### Linux

```bash
sudo apt-get install -y build-essential python3
npm install
```

### Windows

```powershell
# Visual Studio Build Tools + «Desktop development with C++»
npm install
```

---

## Конфигурация

Скопируйте `.env.example` в `.env` и заполните:

```env
TELEGRAM_BOT_TOKEN=
AUTHORIZED_USERS=
OPENCODE_BINARY=opencode
OPENCODE_ARGS=--auto
PROJECTS_ROOT=./projects
DATABASE_URL=./data/remotecode.db
LOG_LEVEL=info
```

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен от @BotFather. Никогда не попадает в исходники и не логируется. |
| `AUTHORIZED_USERS` | ID разрешённых пользователей через запятую. Проверяется **на каждом действии**. Без значения бот не стартует. |
| `OPENCODE_BINARY` | Имя или полный путь к исполняемому файлу CLI. |
| `OPENCODE_ARGS` | Аргументы запуска, разбиваются с учётом кавычек. `--auto` включает автосогласие. |
| `PROJECTS_ROOT` | Корень для создаваемых проектов. |
| `DATABASE_URL` | Путь к SQLite-файлу. |
| `LOG_LEVEL` | `all\|trace\|debug\|info\|warn\|error\|fatal\|silent\|none`. |

Все параметры валидируются Zod при старте: невалидное значение валит запуск
с понятной ошибкой, а не работает «как-нибудь».

**Автосогласие (`--auto`)** включается, если задано хотя бы одно из двух:
переключатель «Автосогласие» в ⚙️ Настройки **или** `OPENCODE_ARGS=--auto` в
`.env` (осознанное решение оператора). Выключенное состояние остаётся
умолчанием, каждый включённый запуск логируется предупреждением.

---

## Запуск

```bash
npm run dev      # разработка (tsx)
npm run start    # production (node dist/index.js)
```

> **Windows (PowerShell):** используйте `npm.cmd run dev` / `npm.cmd start` —
> `npm.ps1` может блокироваться политикой выполнения.

---

## Использование

`/start` показывает состояние и главное меню:

```
RemoteCode

Статус: Online
Проект: NeedRP
Сессия: Авторизация
Модель: Mimo V2.6 Flash (free)
```

Кнопки: 📁 Проекты · 💬 Сессии · 🤖 Модели · ⚙️ Настройки · 📟 Терминал · 📊 Статус

Дальше:

1. **📁 Проекты** → «➕ Новый проект» (создаёт папку) или «📂 Добавить директорию»
   (подключает существующую).
2. **💬 Сессии** → «➕ Новая сессия» → выбрать сессию.
3. Просто напишите сообщение — оно уйдёт в OpenCode **одним промптом**,
   даже если в нём несколько строк.

Команды: `/status` `/stop` `/rename` `/model` `/history` `/terminal`
`/newsession` `/cancel`.

Во время выполнения показывается статус с кнопками
`[⛔ Остановить] [📟 Терминал] [🔄 Обновить]`.

---

## Архитектура

```
src/
├── bot/
│   ├── commands/      # start, projects, sessions, models, settings, status, terminal
│   ├── handlers/      # callback.ts (роутинг кнопок), text.ts (роутинг сообщений)
│   ├── keyboards/     # inline-клавиатуры и контракт callback_data
│   └── middleware/    # auth.ts — проверка AUTHORIZED_USERS на каждом апдейте
├── cli/
│   ├── process-runner.ts   # spawn/killTree/resolveInvocation (распаковка
│   │                       #   npm-шимов Windows), без shell
│   ├── opencode-adapter.ts # ядро: запуск run --format json + NDJSON-парсер
│   ├── process-manager.ts  # Map<sessionId, ProcessInstance>, очередь, отмена
│   ├── model-manager.ts    # opencode models → список и выбор модели
│   ├── session-manager.ts  # session list/export/delete, проверка восстановления
│   ├── pty-adapter.ts      # node-pty для Terminal Mode (conpty.dll с откатом)
│   ├── terminal-session-manager.ts # живые VT-экраны Terminal Mode
│   └── terminal-parser.ts  # виртуальный VT-экран (CSI/OSC/SGR/альт-буфер)
├── projects/project-manager.ts
├── services/
│   ├── message-router.ts   # маршрут сообщения → сессия → процесс
│   └── task-manager.ts     # статусы «в процессе», стриминг, финальный ответ
├── database/          # drizzle-orm: schema.ts, client.ts
├── config/env.ts      # Zod-валидация всей конфигурации
├── utils/             # пути (защита от traversal), ANSI, логгер, ids
├── types.ts           # общие контракты между слоями
├── context.ts         # composition root
└── index.ts           # boot sequence
```

### Изоляция сессий

* `Map<sessionId, ProcessInstance>` — у каждого процесса свой буфер вывода,
  вывод разных процессов не смешивается.
* Одна активная запись в сессию; остальные сообщения идут строгой FIFO-очередью.
* Разные сессии выполняются параллельно.
* Новый экземпляр OpenCode на каждое сообщение **не** создаётся: процесс
  живёт, пока сессия активна.

### Восстановление после перезапуска

PID устаревший и не переиспользуется никогда. Восстановление идёт только через
официальные механизмы CLI:

1. в БД хранится `opencode_session_id`;
2. после рестарта `session list` проверяет, что сессия реально существует;
3. `session export <id>` дополнительно сверяет `location.directory` с путём
   проекта;
4. если сессии нет — пользователю **явно** сообщается, что контекст
   восстановить нельзя. Иллюзия сохранённого контекста не создаётся.

---

## Безопасность

* `AUTHORIZED_USERS` проверяется в middleware **на каждом** апдейте.
* Все вызовы CLI идут через `spawn` с `shell: false` — пользовательский текст
  никогда не подставляется в командную строку (нет shell injection).
* Пути проектов нормализуются, отклоняются NUL/управляющие символы, проверяется
  принадлежность корню (с учётом границы сегмента — `/a/bc` не считается
  внутри `/a/b`) и отсутствие побега через symlink.
* Терминал отдаёт только кураторский набор клавиш — это не произвольный shell.
* Токен не пишется в исходники, редактируется из логов.
* `--auto` (автосогласие инструментов) **выключен по умолчанию** и включается
  только явно; каждый включённый запуск логируется предупреждением.
* Ошибки и стек-трейсы не отправляются в Telegram.

---

## Тестирование

> **Windows:** в PowerShell вызывайте скрипты как `npm.cmd test`
> (просто `npm test` может блокироваться политикой выполнения `npm.ps1`).

```bash
npm test                     # юнит-тесты: без сети и без расхода кредитов моделей
npm run test:integration     # реальный установленный CLI (без промптов моделям)
npm run smoke                # живая цепочка: CLI → run → резюм → смена модели → export
```

Юнит-тесты гоняют **настоящие дочерние процессы**: адаптер подключается к
фикстурам в `tests/fixtures/` через тестовые швы (`binary`/`argvOverride` в
`OpenCodeAdapter`, `binary`/`argv` в `PtyAdapter`) и разыгрывает протокол
`opencode run --format json` без сети:

* `tests/paths.test.ts` — path traversal, границы путей, symlink-побег.
* `tests/telegram-text.test.ts` — `splitMessage` не теряет символы, `stripAnsi`.
* `tests/smoke.test.ts` — конфигурация (валидация, токен не утекает), логгер,
  весь слой репозиториев БД.
* `tests/database.test.ts` — schema/репозитории, порядок сообщений.
* `tests/terminal-parser.test.ts` — виртуальный терминал: курсор, очистка,
  скролл, регионы, SGR, альтернативный буфер, разорванные escape-последовательности.
* `tests/opencode-adapter.test.ts` — NDJSON-парсер и жизненный цикл запуска:
  многострочный промпт одним аргументом, резюм `-s`, модель `-m`, `--auto`,
  ненулевой exit code, отмена, hang guard, «хвост» без `\n`, метасимволы
  оболочки в промпте.
* `tests/process-manager.test.ts` — FIFO внутри сессии, параллельность разных
  сессий, отмена, `flushQueue`, `shutdown`, персист в БД.
* `tests/pty-adapter.test.ts` — Terminal Mode: `encodeLiteral`, кураторские
  клавиши, реальный PTY на фикстуре TUI (пропускается, если node-pty
  недоступен).
* `tests/integration/cli.test.ts` — реальные вызовы установленного CLI
  (`--version`, `models`, `session list`, `verifyContext`); пропускаются, если
  `opencode` не найден.

Фикстуры: `ndjson-ok.cjs` (успешный прогон), `ndjson-tail.cjs` (последнее
событие без `\n`), `ndjson-fail.cjs` (ненулевой exit code), `ndjson-slow.cjs`
(отмена/hang guard), `tty-emitter.cjs` (поток escape-кодов TUI, включая
разрыв последовательности и альтернативный буфер).

`npm run smoke` — единственная проверка, которая шлёт реальные промпты модели
(расход кредитов): первый ответ, многострочный промпт, резюм сессии,
сохранение контекста, смена модели, `session list`/`export`, длинный вывод и
отмена.

---

## Исследование CLI (OpenCode v2.2.5)

Факты, на которых построена реализация:

```
opencode <subcommand> [flags] [<directory>]

  --standalone            Run with a private server instead of the background service
  --server string         Connect to a server URL instead of the background service
  --auto                  Auto-approve permissions that are not explicitly denied
  --continue, -c          Continue the last session
  --session, -s string    Session ID to continue, or to create if it does not exist
  --prompt string         Prompt to use

opencode run [flags] [<message...>]
  --session, -s string    Session ID to continue, or to create if it does not exist
  --model, -m string      provider/model#variant
  --format choice         default | json
  --auto                  Auto-approve permissions that are not explicitly denied

opencode models           # по одному provider/model на строку
opencode session list     # id \t title \t date
opencode session export   # JSON { info, messages }
opencode session delete
```

Проверено экспериментально:

* `run --format json` → NDJSON, каждое событие содержит `sessionID`;
* `step_finish.reason === "stop"` — штатное завершение шага;
* завершение задачи определяется по **выходу процесса**, а не по таймеру;
* `run -s <id>` возвращает **тот же** `sessionID` — контекст сохраняется;
* `-s <id> -m <другая_модель>` переключает модель, продолжая ту же сессию;
* `session export` возвращает `info.location.directory` — по нему сверяется,
  что сессия относится к нужному проекту.
