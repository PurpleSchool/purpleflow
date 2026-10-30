# Как участвовать / Contributing

Спасибо, что хотите помочь PurpleFlow! Ниже — как собрать проект, что проверить перед PR и как здесь принято писать код.

_English summary below._

## Окружение

- Node.js ≥ 22.18 (версия — в `.nvmrc`), git.
- Для живых прогонов — `claude` и/или `codex` в PATH. Для тестов они не нужны: агентов подменяют фейками, а openspec ставится как devDependency.

```bash
npm install
```

```bash
npm run dev
```

## Перед PR

```bash
npm run check
```

Это typecheck (ядро, тесты, e2e, приложение), ESLint, Prettier и тесты ядра и окна — то же самое гоняет CI (ubuntu, macOS, Windows). Форматирование поправит `npm run format`, часть замечаний линтера — `npm run lint:fix`.

Если меняется интерфейс, проверьте его в `npm run dev` и приложите скриншот к PR.

## Как устроен код

Сначала прочитайте [ARCHITECTURE.md](ARCHITECTURE.md). Коротко:

- новая стадия — модуль в `core/src/stages/`, вызов из `drive` в `engine.ts`, маршрут — в `route.ts`;
- новая возможность вокруг стадий — функция `fn(k: Kernel, …)` в `core/src/services/`;
- новый метод для окна — объявление в `CoreApi` (`core/src/model/api.ts`), реализация в `Orchestrator`, ключ в `CORE_METHODS` (`app/src/shared/ipc.ts`). Компилятор подскажет, если что-то забыто;
- окно обращается к main только через `app/src/renderer/src/lib/api.ts`.

## Стиль

- TypeScript `strict`, без `any`, импорты типов — через `import type`.
- Комментарии, сообщения в интерфейсе и названия тестов — по-русски. Комментарий объясняет «почему», а не пересказывает код.
- Тест на поведение конвейера лучше писать в `pipeline.test.ts`: настоящий git и openspec, фейковые агенты.
- Один PR — одна логическая правка.

---

## English summary

1. Node.js ≥ 22.18 and git; run `npm install`, then `npm run dev`. Tests need neither `claude` nor `codex`: agents are faked and openspec is a devDependency.
2. Before opening a PR, run `npm run check` (typecheck, ESLint, Prettier, tests). CI runs the same steps.
3. Read [ARCHITECTURE.md](ARCHITECTURE.md). Stages live in `core/src/stages/`, everything around them in `core/src/services/`, shared state in `kernel.ts`, the run loop in `engine.ts`. A new window-facing method goes into `CoreApi`, `Orchestrator` and `CORE_METHODS`; the compiler checks all three.
4. Code comments and UI strings are in Russian. Issues and PRs in English are welcome.
