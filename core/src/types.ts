// Публичный контракт ядра: настройки, состояние прогона (run.json), события и команды.

export type ToolName = 'git' | 'claude' | 'codex' | 'openspec';

export interface ToolInfo {
  name: ToolName;
  path: string | null;
  version: string | null;
  error?: string;
}

export type Role = 'planner' | 'executor' | 'reviewer';

/** CLI-агент, который выполняет роль. */
export type AgentKind = 'claude' | 'codex';

/** Модели ролей; visual — модель claude для визуальной проверки (пусто — как у исполнителя-claude). */
export type Models = Record<Role, string> & { visual?: string };

export const DEFAULT_AGENTS: Record<Role, AgentKind> = { planner: 'claude', executor: 'claude', reviewer: 'codex' };

export interface CoreSettings {
  /** Ручные пути к CLI; пустая строка — искать в PATH. */
  toolPaths: Partial<Record<ToolName, string>>;
  proxy: {
    /** Base URL прокси. Пусто — агенты используют собственную авторизацию. */
    baseUrl: string;
    /** Отдельный адрес OpenAI-совместимого API для codex; пусто — `${baseUrl}/v1`. */
    codexBaseUrl?: string;
    apiKey: string;
  };
  models: Models;
  /** Агент на роль; по умолчанию планировщик и исполнитель — claude, ревьюер — codex. */
  agents?: Partial<Record<Role, AgentKind>>;
  /**
   * Как claude авторизуется без прокси: 'login' — собственный вход Claude Code
   * (ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL из окружения игнорируются), 'env' — ключ из окружения.
   */
  claudeAuth?: 'login' | 'env';
  /** Сколько прогонов агенты ведут одновременно (остальные ждут в очереди). По умолчанию 2. */
  maxParallel?: number;
  /** Таймаут одной стадии агента, минуты. */
  agentTimeoutMin: number;
  /** Таймаут команды тестов, минуты. */
  testTimeoutMin: number;
}

export type StageId = 'baseline' | 'clarify' | 'gate0' | 'plan' | 'gate1' | 'implement' | 'tests' | 'visual' | 'review' | 'gate2' | 'limit' | 'finish';

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
  source: 'validator' | 'tests' | 'review' | 'human';
  text: string;
  lineComments?: LineComment[];
}

export interface RunFile {
  version: 1;
  id: string;
  changeId: string;
  title: string;
  task: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  testCommand: string;
  setupCommand?: string;
  lintCommand?: string;
  /** Режим (у старых прогонов отсутствует — считается «задачей»). */
  mode?: RunMode;
  /** Рабочая копия ещё не создана (прогон в очереди) — run.json живёт только в данных приложения. */
  workspacePending?: boolean;
  /** Уточнение до плана: вопросы планировщика и ответы человека (они дописываются к задаче для всех стадий). */
  clarify?: { questions: ClarifyQuestion[]; answers?: { q: string; a: string }[]; skipped?: boolean };
  /** Сессия claude исполнителя: следующие попытки продолжают её и получают только замечания. */
  executorSession?: string;
  /** Идёт быстрая правка с приёмки: после зелёных проверок — сразу обратно на приёмку. */
  quickFix?: boolean;
  /** Где шла работа; у старых прогонов — worktree. */
  workspace?: Workspace;
  /** Ветка, на которой была рабочая копия до прогона в режиме «ветка». */
  originalBranch?: string;
  visual?: boolean;
  runCommand?: string;
  appUrl?: string;
  visualNotes?: string;
  envFiles?: string[];
  /** Большая задача: текущий этап реализации и их число (разделы tasks.md). */
  phase?: number;
  phases?: number;
  /** Баг: прогон проверок после воспроизведения — должен быть красным. */
  repro?: TestResult;
  /** Линтер и тесты на базовом коммите, до работы агента: чтобы не требовать починки чужих старых ошибок. */
  baseChecks?: CheckResult[];
  visuals?: VisualResult[];
  /** Команда подготовки (установка зависимостей) уже выполнена в worktree. */
  prepared?: boolean;
  models: Models;
  /** Агенты по ролям на момент старта (у старых прогонов — по умолчанию). */
  agents?: Record<Role, AgentKind>;
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
  /** Ветка psflow/<id> влита человеком из приложения. */
  merged?: { into: string; commit: string; at: string };
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

// ——— События (ядро → UI) ———

export type CoreEvent =
  | { type: 'stage.started'; runId: string; stage: StageId; attempt: number }
  | { type: 'agent.output'; runId: string; stage: StageId; text: string }
  | { type: 'tests.result'; runId: string; result: TestResult }
  | { type: 'review.result'; runId: string; result: ReviewResult }
  | { type: 'gate.waiting'; runId: string; gate: GateId; message?: string }
  | { type: 'stage.failed'; runId: string; stage: StageId; error: string }
  | { type: 'run.finished'; runId: string; status: RunStatus; message?: string }
  /** Кадр браузера агента визуальной проверки (JPEG base64); null — трансляция закончилась. */
  | { type: 'visual.frame'; runId: string; frame: { data: string; url: string; width: number; height: number } | null }
  /** Приложение прогона для ручной проверки во вкладке «Браузер». */
  | { type: 'preview.state'; runId: string; state: PreviewState }
  /** Снимок run.json после каждого изменения — UI просто перерисовывается. */
  | { type: 'run.updated'; run: RunFile }
  | { type: 'run.deleted'; runId: string };

// ——— Команды (UI → ядро) ———

export interface StartRunInput {
  projectPath: string;
  task: string;
  testCommand: string;
  setupCommand?: string;
  lintCommand?: string;
  mode?: RunMode;
  /** Визуальная проверка: команда запуска приложения ({port} — свободный порт) и адрес. */
  runCommand?: string;
  appUrl?: string;
  visual?: boolean;
  visualNotes?: string;
  envFiles?: string[];
  workspace?: Workspace;
  /** Изображения к задаче (скриншоты, макеты) — байты из окна. */
  attachments?: { name: string; data: Uint8Array }[];
}

export type CoreCommand =
  | { type: 'run.start'; input: StartRunInput }
  | { type: 'run.resume'; runId: string }
  | { type: 'gate.approve'; runId: string; comment?: string }
  | { type: 'gate.reject'; runId: string; comment: string; lineComments?: LineComment[] }
  | { type: 'gate.cancel'; runId: string }
  /** Попытки исчерпаны: человек принимает как есть и идёт на приёмку. */
  | { type: 'gate.accept'; runId: string }
  /** Ответы на вопросы уточнения (пустой список — продолжить без ответов). */
  | { type: 'gate.answer'; runId: string; answers: { q: string; a: string }[] }
  /** Приёмка: небольшая правка в той же ветке — потом только проверки и снова приёмка, без ревью и визуальной. */
  | { type: 'gate.fix'; runId: string; comment: string; lineComments?: LineComment[] }
  | { type: 'run.stop'; runId: string }
  | { type: 'run.merge'; runId: string; target: string }
  /** Отправить ветку на GitHub и открыть Pull Request в base. */
  | { type: 'run.pr'; runId: string; base: string }
  /** Влить открытый PR (gh pr merge --merge). */
  | { type: 'run.prMerge'; runId: string }
  /** Удалить прогон: рабочую копию, данные приложения и, по желанию, ветку psflow/<id>. */
  | { type: 'run.delete'; runId: string; deleteBranch: boolean };

export interface DiffFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  original: string;
  modified: string;
  binary?: boolean;
}

export interface ConnectionCheck {
  agent: 'claude' | 'codex';
  ok: boolean;
  model: string;
  durationMs: number;
  reply?: string;
  error?: string;
}

export interface ProjectCommands {
  testCommand: string;
  setupCommand: string;
  lintCommand: string;
  detectedFrom: string | null;
}

/** Команды проекта, сохранённые один раз и подставляемые в каждую задачу. */
export interface ProjectConfig {
  setupCommand: string;
  lintCommand: string;
  testCommand: string;
  runCommand?: string;
  appUrl?: string;
  /** Инструкция агенту визуальной проверки: тестовый вход, сид данных, куда идти. */
  visualNotes?: string;
  /** Файлы окружения (не в git), которые копируются в worktree прогона: apps/api/.env… */
  envFiles?: string[];
  workspace?: Workspace;
  /** Знания о проекте для всех агентов: профиль (стек, структура, соглашения) и уроки прошлых прогонов. */
  knowledge?: ProjectKnowledge;
  notes: { setup: string; lint: string; test: string; run?: string };
  updatedAt: string;
}

/** Проект в списке «Проекты». */
export interface ProjectListItem {
  path: string;
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

/** Ошибка в команде проекта, найденная без запуска. */
export interface CommandIssue {
  /** Что не так — по-русски, для подсказки под полем. */
  message: string;
  /** Исправленная команда, если замена очевидна. */
  fix?: string;
}

/** Категория данных PurpleFlow в каталоге приложения: размер и можно ли почистить. */
export interface StorageItem {
  id: 'worktrees-done' | 'worktrees-active' | 'worktrees-orphan' | 'browser' | 'shots' | 'history' | 'app-cache';
  title: string;
  hint: string;
  bytes: number;
  count: number;
  /** Подпись кнопки очистки; нет — только показываем. */
  clean?: string;
}

/** Состояние Pull Request и проверок CI. */
export interface PrStatus {
  url: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  mergeable: boolean;
  conflicts: boolean;
  /** Слияние заблокировано правилами ветки (нужно ревью, обязательные проверки). */
  blocked: boolean;
  review: string | null;
  checks: { total: number; passed: number; failed: number; pending: number };
  mergeCommit: string | null;
}

export interface ClarifyQuestion {
  q: string;
  /** Варианты ответа, если их можно предложить; человек может ответить своим текстом. */
  options?: string[];
  /** Почему это важно для плана — одной фразой. */
  why?: string;
}

export interface ProjectKnowledge {
  /** Профиль проекта в Markdown: стек, структура, ключевые модули, соглашения, тесты. */
  profile?: string;
  profileAt?: string;
  /** Уроки прошлых прогонов: короткие правила, которые пригодятся следующим. */
  lessons?: { text: string; at: string; runId?: string }[];
}
