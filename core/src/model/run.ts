// Состояние прогона (run.json): стадии, попытки, проверки, ревью, вмешательства человека.

import type { AgentKind, Models, Role } from './settings.js';
import type { PrFollowupItem } from './pr.js';

export type StageId =
  'baseline' | 'clarify' | 'gate0' | 'plan' | 'gate1' | 'implement' | 'tests' | 'visual' | 'review' | 'gate2' | 'limit' | 'finish';

/** Режим работы: какие стадии и правила применяются к задаче. */
export type RunMode = 'quick' | 'bug' | 'task' | 'epic' | 'refactor';

/** Где работают агенты: отдельная worktree (рабочая копия не меняется) или ветка прямо в проекте. */
export type Workspace = 'worktree' | 'branch';

export interface VisualShot {
  /** Абсолютный путь к скриншоту в каталоге данных приложения. */
  file: string;
  caption: string;
}

export interface VisualResult {
  at: string;
  url: string;
  blocking: ReviewItem[];
  notes: ReviewItem[];
  shots: VisualShot[];
  /** Проверить не удалось из‑за окружения (не поднялся API, нет тестового входа…) — это не ошибка реализации. */
  unverified?: string;
  /** Команда запуска и хвост её вывода — чтобы было видно, что не поднялось. */
  command?: string;
  serverOutput?: string;
}

export type GateId = 'gate0' | 'gate1' | 'gate2' | 'limit';

/** queued — ждёт свободного места: одновременно агенты ведут не больше maxParallel прогонов. */
export type RunStatus = 'queued' | 'running' | 'waiting' | 'stopped' | 'cancelled' | 'finished';

export type AttemptStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

export interface StageAttempt {
  stage: StageId;
  /** Порядковый номер попытки этой стадии (с 1). */
  attempt: number;
  startedAt: string;
  endedAt?: string;
  status: AttemptStatus;
  /** Короткий итог для списка стадий. */
  summary?: string;
  /** Итоговый ответ агента (Markdown) — показывается отдельно от лога. */
  output?: string;
  error?: string;
  tokens?: TokenUsage;
  model?: string;
}

export interface CheckResult {
  kind: 'lint' | 'test';
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut?: boolean;
  /** Проверка была красной и до задачи, а ошибок не прибавилось — не блокирует. */
  preexisting?: { before: number | null; after: number | null };
  /**
   * Тесты красные, но не из‑за задачи: при повторе прошли ('retry'), упали другие тесты ('differs')
   * или те же тесты падают и на исходном коде ('base'). Не блокирует — решение за человеком на приёмке.
   */
  unstable?: { reason: 'retry' | 'differs' | 'base'; tests: string[] };
}

export interface TestResult {
  /** Отдельные проверки стадии: линтер и тесты. Верхние поля — сводка по ним. */
  checks?: CheckResult[];
  at: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Хвост вывода (stdout+stderr). */
  output: string;
  timedOut?: boolean;
}

export interface ReviewItem {
  file: string | null;
  line: number | null;
  message: string;
  /** Только в повторном ревью: новое, не исправлено с прошлого раза или появилось из‑за исправления. */
  origin?: 'new' | 'unfixed' | 'from_fix';
}

export interface ReviewResult {
  at: string;
  blocking: ReviewItem[];
  notes: ReviewItem[];
}

export interface LineComment {
  file: string;
  line: number;
  text: string;
  /** Начало текста, к которому оставлено замечание (для плана — пункт или абзац). */
  quote?: string;
}

export interface GateDecision {
  gate: GateId;
  at: string;
  decision: 'approve' | 'reject' | 'cancel' | 'accept' | 'fix';
  comment?: string;
  lineComments?: LineComment[];
}

/** Что передать следующему запуску агента: обратная связь от валидатора, тестов, ревью или человека. */
export interface Feedback {
  source: 'validator' | 'tests' | 'review' | 'human' | 'system';
  text: string;
  lineComments?: LineComment[];
}

/**
 * Управление прогоном на ходу: от человека или предложенное менеджером и подтверждённое человеком.
 * note — заметка следующему запуску планировщика или исполнителя; pause — остановиться перед следующей стадией;
 * restart — прервать реализацию и сделать попытку заново с заметкой; replan — прервать и вернуться к плану.
 */
export type ControlAction =
  | { kind: 'note'; text: string }
  | { kind: 'pause' }
  | { kind: 'restart'; text: string }
  | { kind: 'replan'; text: string; keepCode?: boolean };

/** Вмешательство человека в ход прогона — для журнала, таймлайна и менеджера. */
export interface Intervention {
  at: string;
  kind: ControlAction['kind'];
  text?: string;
  /** Применено (для отложенных: заметка ушла агенту, пауза сработала). */
  appliedAt?: string;
  /** Возврат к плану: снимок работы до него (ref в репозитории) и сохранён ли код. */
  snapshot?: string;
  keepCode?: boolean;
}

/**
 * Команда, которую менеджер предлагает выполнить (тег, push, git, скрипт проекта). Выполняется только по кнопке человека:
 * в папке проекта или в рабочей копии прогона; вывод возвращается в чат.
 */
export interface CommandAction {
  kind: 'command';
  command: string;
  /** Что сделает команда — одной фразой для карточки. */
  text: string;
  cwd: 'project' | 'worktree';
}

export type ManagerAction = ControlAction | CommandAction;

/** Сообщение в чате менеджера прогона. */
export interface ManagerMessage {
  id: string;
  at: string;
  role: 'user' | 'manager';
  text: string;
  /** Действие, которое менеджер предлагает; применяется только по кнопке человека. */
  action?: ManagerAction;
  /** Результат выполненной команды: код выхода и хвост вывода. */
  result?: { code: number | null; output: string };
  actionState?: 'proposed' | 'applied' | 'dismissed';
  error?: boolean;
}

export interface RunFile {
  /** Версия схемы; старые файлы приводятся к текущей в migrate.ts. */
  version: 2;
  id: string;
  changeId: string;
  title: string;
  task: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  /** Ветка, от которой начата задача (её последний коммит — baseCommit). */
  baseBranch?: string;
  testCommand: string;
  setupCommand?: string;
  lintCommand?: string;
  mode: RunMode;
  /** Рабочая копия ещё не создана (прогон в очереди) — run.json живёт только в данных приложения. */
  workspacePending?: boolean;
  /** Уточнение до плана: вопросы планировщика и ответы человека (они дописываются к задаче для всех стадий). */
  clarify?: { questions: ClarifyQuestion[]; answers?: { q: string; a: string }[]; skipped?: boolean };
  /** Сессия claude исполнителя: следующие попытки продолжают её и получают только замечания. */
  executorSession?: string;
  /** Идёт быстрая правка с приёмки: после зелёных проверок — сразу обратно на приёмку. */
  quickFix?: boolean;
  /** Где идёт работа. */
  workspace: Workspace;
  /** Ветка, на которой была рабочая копия до прогона в режиме «ветка». */
  originalBranch?: string;
  visual?: boolean;
  /** Автопилот: план принимается сам, при исчерпанных попытках — одна попытка сама; человек нужен только на приёмке. */
  autopilot?: boolean;
  /** Файлы диффа по пунктам плана — для приёмки «по смыслу»; attempt — номер приёмки, к которой посчитано. */
  taskMap?: { attempt: number; groups: { title: string; files: string[] }[] };
  /** Что пошло не так, но прогон не остановило (не скопировались зависимости, не откатились артефакты…) — видно в окне. */
  warnings?: { at: string; text: string }[];
  /** План покрывает первую часть большой задачи; остальные — в разделе «Next Parts» proposal. */
  nextParts?: boolean;
  /** Автопилот уже дал одну попытку сверх лимита. */
  autoRetried?: boolean;
  runCommand?: string;
  appUrl?: string;
  visualNotes?: string;
  envFiles?: string[];
  /** Большая задача: текущий этап реализации и их число (разделы tasks.md). */
  phase?: number;
  phases?: number;
  /** Баг: прогон проверок после воспроизведения — должен быть красным. */
  repro?: TestResult;
  /** Тесты, которых касается задача (раздел «## Checks» плана): их гоняют до правок и на каждой попытке; полный набор — перед приёмкой. */
  focusTestCommand?: string;
  /** Линтер и тесты на базовом коммите, до работы агента: чтобы не требовать починки чужих старых ошибок. */
  baseChecks?: CheckResult[];
  /** Изменения прогона спрятаны в stash на время проверки тестов на исходном коде; при аварии их вернёт recover(). */
  baseProbeStash?: string;
  visuals?: VisualResult[];
  /** Команда подготовки (установка зависимостей) уже выполнена в worktree. */
  prepared?: boolean;
  models: Models;
  /** Агенты по ролям на момент старта. */
  agents: Record<Role, AgentKind> & { visual?: AgentKind };
  status: RunStatus;
  /** Стадия, которая выполняется сейчас или будет запущена при продолжении. */
  next: StageId;
  /** Вопрос человеку или причина остановки. */
  message?: string;
  attempts: StageAttempt[];
  planRetries: number;
  implAttemptsUsed: number;
  implAttemptsLimit: number;
  tests: TestResult[];
  reviews: ReviewResult[];
  gates: GateDecision[];
  feedback?: Feedback;
  totals: TokenUsage;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Путь к run.json после `openspec archive` (папка изменения переезжает в archive/). */
  archivedPath?: string;
  commit?: string;
  /** Абсолютные пути к изображениям задачи (в каталоге данных приложения, не в репозитории). */
  attachments?: string[];
  /** Название придумал планировщик (первая строка proposal.md). */
  titleFromPlan?: boolean;
  /** Рабочая копия удалена при очистке хранилища: run.json живёт только в данных приложения. */
  worktreeRemoved?: boolean;
  /** Pull Request ветки прогона на GitHub. */
  pr?: { url: string; number: number; base: string; createdAt: string };
  /** Ветка purpleflow/<id> влита человеком из приложения. */
  merged?: { into: string; commit: string; at: string };
  /** Доработка по замечаниям PR: номер текущего круга (первый — исходная реализация) и коммит, от которого считается дифф круга. */
  prRound?: number;
  roundBase?: string;
  prRounds?: {
    round: number;
    at: string;
    items: PrFollowupItem[];
    note?: string;
    commit?: string;
    kind?: 'comments' | 'update';
    conflicts?: string[];
  }[];
  /** Круг «Обновить ветку» без конфликтов: после зелёных проверок — сразу push, без приёмки. */
  mergeOnly?: boolean;
  /** Файлы, по которым показывать дифф круга (разрешённые конфликты), — не весь влитый код базовой ветки. */
  roundFiles?: string[];
  /** «Что изменилось»: короткая сводка диффа для приёмки. */
  changeSummary?: { at: string; text: string; attempt: number };
  /** Отложенные действия человека: применяются на ближайшей контрольной точке (перед стадией). */
  pending?: (ControlAction & { at: string })[];
  interventions?: Intervention[];
  /** Причина последнего возврата к плану — передаётся исполнителю после принятия нового плана. */
  replanNote?: string;
}

export interface RunSummary {
  id: string;
  title: string;
  changeId: string;
  projectPath: string;
  branch: string;
  status: RunStatus;
  next: StageId;
  createdAt: string;
  updatedAt: string;
  runJsonPath: string;
  implAttemptsUsed: number;
  totals: TokenUsage;
  mode?: RunMode;
  missing?: boolean;
}

export interface DiffFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  original: string;
  modified: string;
  binary?: boolean;
}

export interface ClarifyQuestion {
  q: string;
  /** Варианты ответа, если их можно предложить; человек может ответить своим текстом. */
  options?: string[];
  /** Почему это важно для плана — одной фразой. */
  why?: string;
}

/** Запущенное из ветки прогона приложение для ручной проверки. */
export interface PreviewState {
  status: 'idle' | 'starting' | 'ready' | 'failed';
  url?: string;
  command?: string;
  error?: string;
  /** Хвост вывода сервера — чтобы понять, почему не поднялось. */
  output?: string;
}

export interface ModeSuggestion {
  mode: RunMode;
  reason: string;
}
