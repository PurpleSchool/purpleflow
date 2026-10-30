# Архитектура PurpleFlow

PurpleFlow — оркестратор: своих агентов у него нет, стадии выполняют установленные CLI `claude` и `codex`. Код делится на ядро (`core/`, чистый TypeScript без Electron) и приложение (`app/`, Electron + React).

## Процессы

```
renderer (React)  ──window.purpleflow──▶  preload  ──IPC──▶  main  ──MessagePort──▶  utilityProcess: core-host
                                                                                      └─ Orchestrator (core)
                                                                                         └─ claude, codex, git, тесты — дочерние процессы
```

- **renderer** — интерфейс. Окно работает с `sandbox` и `contextIsolation`, без Node. К main оно обращается только через `src/renderer/src/lib/api.ts`.
- **preload** — мост `window.purpleflow`. Методы ядра в него попадают из реестра `CORE_METHODS` (`app/src/shared/ipc.ts`).
- **main** — окно, уведомления, настройки и аккаунт PurpleSchool. Ключи хранятся через `safeStorage` и в окно не уходят. Вызовы ядра main пересылает в utilityProcess.
- **core-host** — ядро в отдельном процессе, чтобы окно не подвисало от агентов и git. Вызывает только методы из реестра.

## Ядро: слои

Зависимости направлены только вниз:

```
orchestrator.ts   фасад: implements CoreApi, разводит команды по модулям
      │
engine.ts         цикл стадий drive, очередь, гейты, решения человека, start/stop/resume, восстановление
      │
stages/           plan · implement · checks · review · visual · finish
services/         agents · prompting · attachments · workspace · projects · pr · preview · runs · disk
                  control · manager · chat · connection
      │
kernel.ts         общее состояние и инфраструктура: события, run.json, лог, попытки стадий, инструменты
      │
model/, parse.ts, route.ts, git.ts, proc.ts, env.ts, store.ts …   типы и чистые утилиты
```

- **Kernel** — единственный объект с изменяемым состоянием прогонов: какие прогоны сейчас крутятся, фоновые проверки, превью, занятые чаты. Ещё в нём общие операции: `save`, `log`, `begin`/`end` попытки, `fail`, `tools`. Доменной логики в Kernel нет, от стадий и сервисов он не зависит.
- **Стадии и сервисы** — функции вида `fn(h: Kernel, …)`. Друг друга они вызывают напрямую. Две операции движка им всё же нужны: `drive` (продолжить цикл) и `halt` (остановить стадию). Их стадии получают через `h.engine` (`EngineHooks`). Связывает эти хуки Orchestrator, поэтому ни стадии, ни сервисы не импортируют `engine.ts`.
- **Движок** знает про все стадии: `drive` вызывает их по `run.next`, пока прогон в статусе `running`, а на гейте останавливается и ждёт человека.
- **Orchestrator** — тонкий фасад для `core-host`, тестов и `scripts/e2e.ts`. Проверка `implements CoreApi` гарантирует, что фасад покрывает весь API окна.

## Прогон

Состояние прогона хранится в `run.json` (`RunFile`, `model/run.ts`) внутри изменения OpenSpec в рабочей копии. Копия и индекс лежат в данных приложения. Каждое изменение сохраняется через `kernel.save`. Это одновременно и запись на диск, и событие `run.updated` для окна.

Маршрут — куда идти после проверок, что пропускается, где «попытки исчерпаны» — вынесен в чистые функции `route.ts`. Их используют и ядро, и окно, так что расходиться им негде.

## Протокол

- **Команды** окна → ядро — `CoreCommand` (`model/protocol.ts`), вызываются через `dispatch`.
- **События** ядро → окно — `CoreEvent`.
- **Запросы данных** — остальные методы `CoreApi` (`model/api.ts`).

Новый метод API добавляется в три места, и компилятор следит, чтобы ни одно не потерялось:
1. объявление в `CoreApi`;
2. реализация в `Orchestrator`;
3. ключ в `CORE_METHODS`.

## Окно

- `screens/` — экраны. Большие экраны разложены по папкам: `run/`, `projects/`, `settings/`.
- `components/` — переиспользуемые части: дифф, таймлайн, терминал, PR, браузер.
- `lib/` — `api.ts` (мост), `store.tsx` (навигация, прогоны, чаты, настройки), `stages.ts` (названия и маршрут стадий для интерфейса).
- `styles/` — CSS по разделам. Порядок импорта в `app.css` важен.

## Тесты

- `core/src/*.test.ts` — `node:test` через `tsx`.
- `pipeline.test.ts` и `chat.test.ts` прогоняют конвейер и чат целиком: временный git-репозиторий, настоящие git и openspec, фейковые агенты (`CoreOptions.runners`).
- `scripts/e2e.ts` — тот же флоу на настоящих агентах, вручную.
