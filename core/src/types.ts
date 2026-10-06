// Публичный контракт ядра: настройки, состояние прогона (run.json), события и команды.

export type ToolName = 'git' | 'claude' | 'codex' | 'openspec';

export interface ToolInfo {
  name: ToolName;
  path: string | null;
  version: string | null;
  error?: string;
}

export type Role = 'planner' | 'executor' | 'reviewer';

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
  models: Record<Role, string>;
  /**
   * Как claude авторизуется без прокси: 'login' — собственный вход Claude Code
   * (ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL из окружения игнорируются), 'env' — ключ из окружения.
   */
  claudeAuth?: 'login' | 'env';
  /** Таймаут одной стадии агента, минуты. */
  agentTimeoutMin: number;
  /** Таймаут команды тестов, минуты. */
  testTimeoutMin: number;
}

export type StageId = 'plan' | 'gate1' | 'implement' | 'tests' | 'review' | 'gate2' | 'limit' | 'finish';

export type GateId = 'gate1' | 'gate2' | 'limit';

export type RunStatus = 'running' | 'waiting' | 'stopped' | 'cancelled' | 'finished';

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
  error?: string;
  tokens?: TokenUsage;
  model?: string;
}

export interface TestResult {
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
  decision: 'approve' | 'reject' | 'cancel';
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
  /** Команда подготовки (установка зависимостей) уже выполнена в worktree. */
  prepared?: boolean;
  models: Record<Role, string>;
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
  /** Снимок run.json после каждого изменения — UI просто перерисовывается. */
  | { type: 'run.updated'; run: RunFile };

// ——— Команды (UI → ядро) ———

export interface StartRunInput {
  projectPath: string;
  task: string;
  testCommand: string;
  setupCommand?: string;
}

export type CoreCommand =
  | { type: 'run.start'; input: StartRunInput }
  | { type: 'run.resume'; runId: string }
  | { type: 'gate.approve'; runId: string; comment?: string }
  | { type: 'gate.reject'; runId: string; comment: string; lineComments?: LineComment[] }
  | { type: 'gate.cancel'; runId: string }
  | { type: 'run.stop'; runId: string }
  | { type: 'run.merge'; runId: string; target: string };

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
  detectedFrom: string | null;
}
