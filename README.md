# PS Flow — прототип оркестратора стадий на OpenSpec

Задача проходит жёсткие стадии: **план → утверждение → реализация → тесты → ревью другой моделью → приёмка → архив и коммит**.
Своего агента нет: стадии выполняют установленные CLI `claude` и `codex`. PS Flow отвечает только за оркестрацию, гейты и интерфейс.

Каждая задача — одно изменение OpenSpec в отдельной git worktree на ветке `psflow/<change-id>`. Рабочая копия пользователя не трогается, merge делает человек.

```
core/        ядро на чистом TypeScript, без Electron: стадии, гейты, агенты, run.json
  prompts/   промпты стадий (*.md) и JSON-схема ответа ревьюера
  scripts/   e2e.ts — headless-прогон флоу на настоящих агентах
app/         Electron + electron-vite + React; ядро работает в utilityProcess
test-repo/   шаблон тестового TypeScript-проекта для критерия приёмки 2
scripts/     make-test-repo.mjs — развернуть test-repo как git-репозиторий
```

## Установка и запуск

Нужны Node.js ≥ 22.18, git и агенты:

```bash
npm i -g @anthropic-ai/claude-code @openai/codex @fission-ai/openspec
```

```bash
npm install
```

```bash
npm run dev
```

При первом запуске откроется экран настройки: найденные `git`, `claude`, `codex`, `openspec` (путь и версия), прокси, модели по ролям и кнопка «Проверить подключение».

## Сборка

```bash
npm run dist:mac -w @psflow/app
```

```bash
npm run dist:win -w @psflow/app
```

```bash
npm run dist:linux -w @psflow/app
```

Результат — в `app/release/`. Все зависимости приложения бандлятся (main + utilityProcess + renderer), поэтому в пакете нет `node_modules`; промпты кладутся в `Resources/prompts`.

**macOS, подпись и нотаризация.** `electron-builder` берёт сертификат «Developer ID Application» из связки ключей (или `CSC_LINK` + `CSC_KEY_PASSWORD`). Нотаризация включена (`notarize: true` в `app/electron-builder.yml`) и требует переменных:

```bash
export APPLE_API_KEY=~/keys/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

или `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`. Hardened runtime и entitlements — в `app/build/entitlements.mac.plist`.

Сборка без подписи (для локальной проверки):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir -w @psflow/app -- -c.mac.notarize=false
```

**Windows.** Подпись — `CSC_LINK`/`CSC_KEY_PASSWORD` (или `WIN_CSC_LINK`). Установщик NSIS.

## Флоу «Простая задача»

| # | Стадия | Кто | Что происходит | Дальше |
|---|---|---|---|---|
| 0 | Старт | человек | папка проекта, текст задачи, команда тестов (автоопределение из package.json / go.mod / pyproject.toml / Cargo.toml) | worktree + `openspec init`, если в репозитории его нет |
| 1 | План | claude, роль «планировщик» | `proposal.md`, `tasks.md`, дельты в `specs/`; затем `openspec validate <id> --strict` | валидно → G1; иначе повтор с ошибками валидатора, до 2 раз, потом стоп |
| G1 | Утверждение плана | человек | Принять / Вернуть с комментарием / Отменить | → 2 / → 1 с комментарием / отмена |
| 2 | Реализация | claude, роль «исполнитель» | выполняет tasks.md, отмечает пункты | → 3 |
| 3 | Тесты | оркестратор | команда тестов в worktree | зелёные → 4; красные → 2 с выводом; после 3 попыток — вопрос человеку |
| 4 | Ревью | codex, роль «ревьюер» | дифф ветки против proposal/tasks, ответ `{ "blocking": [...], "notes": [...] }` по JSON-схеме | нет blocking → G2; есть → 2 (тратит попытку) |
| G2 | Приёмка | человек | Monaco diff, замечания ревьюера на строках, свои замечания | Принять → 5; Вернуть → 2 с замечаниями |
| 5 | Завершение | оркестратор | `openspec archive <id> -y`, коммит в `psflow/<id>` | готово |

Правила попыток:

- Лимит реализации — 3 попытки на прогон. Красные тесты и blocking-замечания ревьюера тратят попытку.
- Когда попытки кончились, прогон ждёт решения: «Ещё попытка» (с необязательной подсказкой исполнителю) или «Остановить».
- Возврат с приёмки (G2) — решение человека, он даёт ещё одну попытку сверх лимита.
- Сбой самого агента (нет ключа, кончились токены, таймаут) попытку не тратит: прогон останавливается с понятным сообщением, «Продолжить» повторяет стадию.

Промпты стадий: `core/prompts/planner.system.md`, `plan.md`, `executor.system.md`, `implement.md`, `review.md`, `feedback.md`, `review.schema.json`.

## Режимы

Режим выбирается на экране новой задачи; кнопка «Авто» просит нейросеть предложить его по тексту задачи.

| Режим | Стадии | Особенности |
|---|---|---|
| Быстрая правка | реализация → проверки → [визуальная] → [ревью] → приёмка → коммит | без OpenSpec; ревью только если дифф больше 120 строк; название пишет исполнитель |
| Баг | воспроизведение → подтверждение причины → исправление → проверки → … | планировщик пишет падающий тест; оркестратор засчитывает воспроизведение, только если проверки красные |
| Задача | план → утверждение → реализация → проверки → … | основной флоу |
| Большая задача | дизайн и план → утверждение дизайна → реализация по этапам → … | обязателен `design.md`; этапы = разделы `## N.` в tasks.md, проверки и свой запас попыток на каждом этапе |
| Рефакторинг | базовые проверки → план → … | проверки обязаны быть зелёными до начала; изменение с `skip_specs`; правка файлов тестов возвращает задачу исполнителю |

Правила режимов — в `core/prompts/{planner,executor}.<режим>.md`, порядок стадий — `core/src/modes.ts`.

## Визуальная проверка

Включается, если в «Командах проекта» заданы команда запуска приложения и адрес (`{port}` — свободный порт, который подставит оркестратор, например `npm run dev -- --port {port}` и `http://localhost:{port}`). Стадия идёт после зелёных проверок:

1. оркестратор поднимает приложение в worktree и ждёт ответа по адресу;
2. claude с доступом только к Bash и чтению управляет браузером через [Playwright CLI](https://www.npmjs.com/package/@playwright/cli) (`@playwright/cli`, обёртка `pw` со своей сессией и папкой — служебные файлы не попадают в репозиторий); браузер — установленный Google Chrome;
3. проходит сценарии спецификаций, снимает скриншоты десктопа и мобильной ширины, смотрит консоль, сверяет с приложенными макетами;
4. ответ `{ blocking, notes, shots }`: blocking возвращает задачу исполнителю со скриншотами; скриншоты показываются в деталях стадии и уходят ревьюеру codex через `--image`.

CLI выбран вместо Playwright MCP ради экономии токенов: нет схем инструментов в контексте, снимок страницы компактный.

Второй тестовый проект — веб-приложение с заложенным багом: `npm run make-test-repo -- --web ~/psflow-sample-web` (команда запуска `PORT={port} npm start`).

## Ядро: события и команды

Ядро (`core/src/orchestrator.ts`) не знает об Electron и общается только событиями и командами — из него можно собрать CLI (`core/scripts/e2e.ts` — пример такого headless-клиента).

- События: `stage.started`, `agent.output` (поток для лога), `tests.result`, `review.result`, `gate.waiting`, `stage.failed`, `run.finished` и служебное `run.updated` (снимок run.json для перерисовки UI).
- Команды: `run.start`, `gate.approve`, `gate.reject(comment, lineComments[])`, `gate.cancel`, `run.stop`, `run.resume`.

В приложении ядро живёт в `utilityProcess` (`app/src/main/core-host.ts`), агенты и тесты — его дочерние процессы, так что окно не подвисает.

## Состояние и метрики: run.json

`openspec/changes/<id>/run.json` в worktree (после архива — в `openspec/changes/archive/<дата>-<id>/run.json`, попадает в коммит):

- стадии и попытки: `attempts[]` со временем начала и конца, статусом, итогом, ошибкой, моделью и токенами (`input`, `output`, `cacheRead`, `cacheWrite`, `costUsd` — claude отдаёт стоимость, codex только токены);
- `tests[]` — команда, код выхода, длительность, хвост вывода;
- `reviews[]` — blocking и notes с файлом и строкой;
- `gates[]` — решения человека с комментариями и замечаниями на строках;
- `implAttemptsUsed` / `implAttemptsLimit`, `planRetries`, `totals`, `next` (куда продолжать), `status`.

Каталог данных приложения (`<userData>/data`) хранит только индекс путей к run.json (`runs.json`), логи агентов (`logs/<runId>.log`) и сами worktree (`worktrees/`). После перезапуска приложения прогоны, оборванные посреди стадии, помечаются «остановлен» и продолжаются с той же стадии; прогоны на гейте ждут решения дальше.

## Вызов агентов

Проверено на версиях:

| CLI | Версия |
|---|---|
| claude (Claude Code) | 2.1.286 |
| codex (codex-cli) | 0.160.1 |
| openspec (@fission-ai/openspec) | 1.14.1 |
| git | 2.54.0 |
| Node.js | 22.19.0 |

**claude** (`core/src/agents/claude.ts`), промпт идёт через stdin — так нет ограничений длины командной строки Windows:

```
claude -p --output-format stream-json --verbose
       --permission-mode bypassPermissions
       --setting-sources project,local --strict-mcp-config
       --no-session-persistence
       --model <модель роли> --append-system-prompt <роль из prompts/*.system.md>
```

- `--setting-sources project,local` и `--strict-mcp-config` — пользовательские хуки, плагины, MCP и `env` из `~/.claude` не вмешиваются в прогон (и не меняются).
- `--permission-mode bypassPermissions` — агент работает автономно, но только внутри отдельной worktree.
- Прокси: `ANTHROPIC_BASE_URL=<base URL>`, `ANTHROPIC_AUTH_TOKEN=<ключ>` (`ANTHROPIC_API_KEY` убирается), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Только в окружении процесса агента.
- Из stream-json берём `assistant` (текст и вызовы инструментов — в лог), `user.tool_result`, финальный `result` (`usage`, `total_cost_usd`, `is_error`).

**codex** (`core/src/agents/codex.ts`), промпт через stdin (`-`):

```
codex exec --json --ephemeral --skip-git-repo-check --color never
           -C <worktree> -s read-only
           -m <модель ревьюера>
           --output-schema <review.schema.json> -o <файл последнего сообщения> -
```

- Прокси подключается отдельным провайдером через `-c`, без правки `~/.codex/config.toml`:
  `--ignore-user-config -c model_provider=psflow -c model_providers.psflow.base_url=<URL> -c model_providers.psflow.env_key=PSFLOW_OPENAI_API_KEY -c model_providers.psflow.wire_api=responses`, ключ — в `PSFLOW_OPENAI_API_KEY`. URL для codex — отдельное поле в настройках, по умолчанию `<base URL>/v1`.
- Из JSONL берём `item.completed` (`agent_message`, `command_execution`, `reasoning`), `turn.completed.usage`, `error`/`turn.failed`.

**openspec**: `init --tools none --no-animation .`, `validate <id> --type change --strict --json --no-interactive`, `archive <id> -y --json`.

Ключ прокси хранится зашифрованным через Electron `safeStorage` (Keychain / DPAPI / libsecret) в `<userData>/settings.json`, в окно не передаётся.

## Платформенные детали

- **PATH на macOS.** Приложение из Finder получает урезанный PATH. Ядро берёт окружение login-шелла (`$SHELL -ilc env`, как shell-env/fix-path), добавляет типичные каталоги (`~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, …) и позволяет указать пути к CLI вручную в настройках.
- **Windows.** CLI из npm — `.cmd`-обёртки: поиск учитывает `PATHEXT`, запуск — через `cross-spawn`.
- **Git.** Операции над одной worktree (дифф для окна, дифф для ревьюера, коммит) выполняются по очереди, при занятом `index.lock` — повтор.
- **Аварийный выход.** PID-ы процессов прогона пишутся в `<userData>/data/pids/`; при следующем старте ядро добивает выживших, чтобы они не писали в worktree параллельно с повтором стадии. Оборванная реализация попытку не тратит.
- **Стоп.** Все процессы прогона (агенты, тесты, подготовка) регистрируются по группе; «Стоп» и выход из приложения убивают деревья целиком через `tree-kill` (SIGTERM, через 3 с SIGKILL).
- **Ошибки агента** (нет ключа, кончились токены, лимит, недоступна модель, нет сети, таймаут) превращаются в понятное сообщение на экране прогона, прогон получает статус «остановлен».

## Проверка

```bash
npm test
```

Юнит-тесты ядра: id изменений, разбор ответа ревьюера, убийство дерева процессов.

Тестовый репозиторий для критерия 2 (небольшой TypeScript-проект с тестами на `node:test`, без зависимостей):

```bash
npm run make-test-repo -- ~/psflow-sample
```

Задача для проверки: «Добавь функцию slugify(s: string): string в src/strings.ts: переводит строку в kebab-case латиницей (кириллицу транслитерирует), убирает всё кроме букв, цифр и дефисов. Добавь тест.»

Headless-прогон того же флоу без GUI (автоматически принимает гейты; `--reject-plan` один раз возвращает план с комментарием):

```bash
cd core && npx tsx scripts/e2e.ts --repo ~/psflow-sample --reject-plan "Добавь в tasks.md пункт про README"
```

## Что проверено (06.10.2026, macOS arm64)

| Критерий | Как проверено | Итог |
|---|---|---|
| Приложение запускается «из Finder» и находит claude и codex | `open` упакованного `PS Flow.app` (LaunchServices, урезанный PATH) | git, claude 2.1.286, codex 0.160.1 найдены через login-шелл |
| Задача проходит все стадии до архива и коммита | headless e2e и живой прогон через окно на `test-repo` | коммит в `psflow/<id>`, изменение в `openspec/changes/archive/`, тесты зелёные |
| Красные тесты → повтор с выводом → стоп после 3 попыток | e2e с заведомо красной командой тестов | 3 реализации, исполнитель цитирует вывод тестов, затем вопрос человеку |
| «Вернуть с комментарием» доходит до агента | возврат на G1 и на G2 с замечанием на строке | планировщик добавил пункт, исполнитель выполнил замечание на строке |
| «Стоп» не оставляет живых процессов | стоп посреди плана + юнит-тест дерева процессов | 0 живых процессов |
| Прогон продолжается после перезапуска | аварийный выход ядра посреди реализации, новый процесс | стадия помечена «прервано», сироты убиты по PID, прогон дошёл до коммита |
| Рабочая копия и глобальные конфиги не изменены | `git status` в репозитории пользователя | чисто, на `main`; ~/.claude и ~/.codex не трогаются |

Не проверено на этой машине: подписанная и нотаризованная сборка (нет сертификата Developer ID — конфигурация готова, нужны ключи из раздела «Сборка») и запуск на Windows (сборка `dist:win` настроена, поиск `.cmd` и `cross-spawn` есть, но живого прогона не было). Ревьюер codex в прогонах ни разу не дал blocking — возврат по blocking проверен логикой ядра, не живой моделью.

## Не входит в прототип

Флоу «Баг» и «Большая задача», параллельные прогоны, вход через аккаунт PurpleSchool, баланс токенов, автообновление, merge и PR, CLI-версия.
