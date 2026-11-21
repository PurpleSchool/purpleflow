// Проекты: команды, знания, окружение, статистика.

import type { ForgeRef } from './pr.js';
import type { RunMode, StageId, Workspace } from './run.js';

export interface ProjectCommands {
  testCommand: string;
  setupCommand: string;
  lintCommand: string;
  detectedFrom: string | null;
}

/**
 * Проект из нескольких репозиториев: верхняя папка (сама не репозиторий) и отмеченные в ней репозитории.
 * Проект записан на основной репозиторий — в нём план OpenSpec, профиль и уроки; repos — остальные участники, пути от root.
 */
export interface MultiRepo {
  root: string;
  repos: string[];
}

export interface RelatedRepo {
  path: string;
  /** Что это за репозиторий — подсказка агентам: «бэкенд API», «общие типы». */
  note?: string;
}

/** Команды проекта, сохранённые один раз и подставляемые в каждую задачу. */
export interface ProjectConfig {
  setupCommand: string;
  lintCommand: string;
  testCommand: string;
  /** Быстрые тесты для промежуточных кругов (например, unit без e2e); полный testCommand — один раз перед приёмкой. */
  quickTestCommand?: string;
  /** Подготовка перед каждым запуском приложения (миграции, сиды) — визуальная проверка, «Браузер», проверка окружения. */
  prepareCommand?: string;
  runCommand?: string;
  appUrl?: string;
  /** Инструкция агенту визуальной проверки: тестовый вход, сид данных, куда идти. */
  visualNotes?: string;
  /** Файлы окружения (не в git), которые копируются в worktree прогона: apps/api/.env… */
  envFiles?: string[];
  /** Соседние репозитории: агенты читают их для контекста (API бэкенда, общие типы), но не меняют. */
  relatedRepos?: RelatedRepo[];
  workspace?: Workspace;
  /** Несколько репозиториев в одной папке: прогон берёт их все, агенты и команды работают из верхней папки. */
  multiRepo?: MultiRepo;
  /** Провайдер Pull/Merge Request и хост; без него провайдер определяется по origin для github.com и gitlab.com. */
  forge?: ForgeRef;
  /** Знания о проекте для всех агентов: профиль (стек, структура, соглашения) и уроки прошлых прогонов. */
  knowledge?: ProjectKnowledge;
  notes: { setup: string; lint: string; test: string; run?: string };
  updatedAt: string;
}

/** Результат `detectForge`: что видно по origin и что уже сохранено в настройках проекта. */
export interface ForgeDetectionInfo {
  remote: string | null;
  host: string | null;
  suggested: ForgeRef | null;
  /** Хост точно известен (github.com, gitlab.com) — подтверждать не нужно. */
  confirmed: boolean;
  saved: ForgeRef | null;
}

/** Заготовка следующей части большой задачи: текст, проект, вложения, от какой ветки начать. */
export interface NextPartDraft {
  projectPath: string;
  task: string;
  attachments: string[];
  baseBranch?: string;
  /** Что осталось после этой части. */
  rest: string[];
}

/** Проверка окружения проекта для визуальной проверки: поднялось ли приложение, работает ли вход и данные. */
export interface EnvCheck {
  ready: boolean;
  url?: string;
  command?: string;
  steps: { title: string; ok: boolean; detail: string }[];
  fix?: string;
  serverOutput?: string;
  at: string;
}

/** Ветки проекта для выбора, от какой начать задачу. */
export interface ProjectBranches {
  /** Локальные ветки и ветки origin, которых нет локально (`origin/…`). */
  branches: { name: string; remote: boolean; at: string }[];
  current: string | null;
}

/** Что нашли в папке, выбранной под проект. */
export interface DetectedProject extends ProjectCommands {
  envFiles: string[];
  isRepo: boolean;
  name: string;
  /** Папка лежит внутри этого репозитория. */
  repoRoot?: string;
  /** git init сделан, но коммитов нет: прогону не от чего ответвиться. */
  empty?: boolean;
  /** Папка не репозиторий, но в ней есть репозитории — пути от неё: можно собрать проект из нескольких. */
  nested?: string[];
  /** Папка уже собрана в проект из нескольких репозиториев — он записан на этот основной репозиторий. */
  projectOf?: string;
}

/** Сохранение настроек проекта: multiRepo не передан — остаётся прежним, null — проект снова из одного репозитория. */
export type ProjectConfigInput = Omit<ProjectConfig, 'updatedAt' | 'multiRepo' | 'forge'> & {
  multiRepo?: MultiRepo | null;
  /** undefined оставляет прежний провайдер PR/MR, null сбрасывает к автоопределению по origin. */
  forge?: ForgeRef | null;
};

/** Проект в списке «Проекты». */
export interface ProjectListItem {
  path: string;
  /** Проект из нескольких репозиториев: его верхняя папка (path — основной репозиторий). */
  root?: string;
  /** Есть сохранённые команды проекта. */
  configured: boolean;
  /** Папка на месте. */
  exists: boolean;
  updatedAt?: string;
  runs: number;
  /** Идут, ждут решения или в очереди. */
  active: number;
  lastRunAt: string | null;
}

/** Статистика проекта для вкладки «Обзор». */
export interface ProjectStats {
  total: number;
  finished: number;
  active: number;
  stopped: number;
  cancelled: number;
  /** Завершены без возврата плана или результата человеком. */
  firstPass: number;
  /** Медиана от постановки задачи до готового коммита. */
  medianLeadMs: number | null;
  /** Время работы агентов и время ожидания решений человека — по всем прогонам. */
  agentMs: number;
  waitMs: number;
  avgImplAttempts: number | null;
  /** Сколько раз работа возвращалась: человеком на плане и приёмке, красными проверками, ревью, визуальной проверкой. */
  returns: { plan: number; acceptance: number; tests: number; review: number; visual: number };
  byMode: { mode: RunMode; total: number; finished: number }[];
  /** По дням за последние 4 недели. */
  daily: { day: string; started: number; finished: number }[];
  /** На каких стадиях прогоны останавливались. */
  stops: { stage: StageId; count: number }[];
  tokens: number;
  merged: number;
  prs: number;
}

export interface ProjectOverview {
  branch: string | null;
  /** Изменённых файлов в рабочей копии. */
  dirty: number;
  remote: string | null;
  /** null — PR создать можно, иначе причина. */
  prReady: string | null;
}

/** Команды, которые нашла нейросеть, с пояснением, откуда они взяты. */
export interface AiCommands {
  setupCommand: string;
  lintCommand: string;
  testCommand: string;
  runCommand: string;
  appUrl: string;
  visualNotes: string;
  notes: { setup: string; lint: string; test: string; run: string };
}

/** Ошибка в команде проекта, найденная без запуска. */
export interface CommandIssue {
  /** Что не так — по-русски, для подсказки под полем. */
  message: string;
  /** Исправленная команда, если замена очевидна. */
  fix?: string;
}

export interface ProjectKnowledge {
  /** Профиль проекта в Markdown: стек, структура, ключевые модули, соглашения, тесты. */
  profile?: string;
  profileAt?: string;
  /** Уроки прошлых прогонов: короткие правила, которые пригодятся следующим. */
  lessons?: { text: string; at: string; runId?: string }[];
}

export type ProjectLesson = NonNullable<ProjectKnowledge['lessons']>[number];
