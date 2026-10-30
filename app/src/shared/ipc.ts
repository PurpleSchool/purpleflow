import type {
  AgentKind, ChatFile, ChatSummary, ManagerMessage, Models, AiCommands, EnvCheck, NextPartDraft, CommandIssue, PrStatus, ProjectKnowledge, ProjectListItem, ProjectOverview, ProjectStats, PrDetails, ProjectBranches, StorageItem, ConnectionCheck, ModeSuggestion, PreviewState, ProjectConfig, CoreCommand, CoreEvent, DiffFile, ProjectCommands, Role, RunFile, RunSummary, ToolInfo, ToolName,
} from '@purpleflow/core';

/** Настройки, как их видит окно: ключ прокси никогда не уходит в renderer. */
export interface PublicSettings {
  toolPaths: Partial<Record<ToolName, string>>;
  /** enabled — ключ подставляется агентам; выключенный ключ хранится, но не используется. */
  proxy: { baseUrl: string; codexBaseUrl: string; hasKey: boolean; enabled: boolean };
  models: Models;
  agents: Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind };
  agentTimeoutMin: number;
  testTimeoutMin: number;
  maxParallel: number;
  onboarded: boolean;
  windowGlass: boolean;
  notify: boolean;
  sound: boolean;
  claudeAuth: 'login' | 'env';
  userConfig: boolean;
  /** Вход в PurpleSchool: null — не вошли. Токен в окно не передаётся. */
  account: { email: string; name: string; /** Аватар data URL; пусто — фото в профиле нет. */ photo: string } | null;
  authPrompted: boolean;
}

export interface SettingsPatch {
  toolPaths?: Partial<Record<ToolName, string>>;
  proxy?: { baseUrl?: string; codexBaseUrl?: string; apiKey?: string; enabled?: boolean };
  models?: Partial<Models>;
  agents?: Partial<Record<Role, AgentKind>> & { visual?: AgentKind; manager?: AgentKind };
  agentTimeoutMin?: number;
  testTimeoutMin?: number;
  maxParallel?: number;
  onboarded?: boolean;
  windowGlass?: boolean;
  notify?: boolean;
  sound?: boolean;
  claudeAuth?: 'login' | 'env';
  userConfig?: boolean;
  authPrompted?: boolean;
}

/** Ответ запросов к PurpleSchool: ошибки — понятным текстом, а не исключением IPC. */
export type AccountResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; /** unauthorized — токен больше не действует, нужен вход заново. */ code?: 'unauthorized' | 'exists' | 'rate' | 'network' };

/** Ключ AI-прокси из аккаунта: сам ключ в окно не уходит, только хвост для узнавания. */
export interface AccountKey {
  id: number;
  name: string;
  tail: string;
  active: boolean;
  current: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Баланс и план AI-прокси (GET /public/ai-proxy/overview). Юниты — строками: в БД это BigInt. */
export interface AccountOverview {
  balance: { totalInitialUnits: string; usedUnits: string; usedPercentage: number; remainingUnits: string; nonRolloverRemainingUnits: string; averageDailyUnitsSpend: string; estimatedRemainingDays: number | null };
  currentPlan: { title: string; priceMinor: number; unitsPerMonth: string; nextPaymentAt: string; isAutoPaymentEnabled: boolean } | null;
}

export type UsageBucket = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export interface UsageModelSpend { modelName: string; unitsSpend: string; requestsCount: number }
/** Расход AI-прокси (GET /public/ai-proxy/usage). */
export interface AccountUsage {
  timeSeries: { bucketType: UsageBucket; period: { from: string; to: string }; buckets: { date: string; totalUnitsSpend: string; modelUnitsSpend: UsageModelSpend[] }[] };
  modelSummary: { models: UsageModelSpend[]; totalUnitsSpend: string; totalRequests: number; averageUnitsSpendPerBucket: string };
}

export interface AccountApi {
  login(email: string, password: string): Promise<AccountResult>;
  register(p: { name: string; email: string; password: string; mailing: boolean }): Promise<AccountResult>;
  restore(email: string): Promise<AccountResult<string>>;
  logout(): Promise<void>;
  /** Обновить имя и аватар из профиля PurpleSchool. */
  profile(): Promise<AccountResult>;
  keys(): Promise<AccountResult<{ items: AccountKey[]; limit: number }>>;
  createKey(): Promise<AccountResult>;
  useKey(id: number): Promise<AccountResult>;
  /** Ключа ещё нет — подставить существующий активный; нет и такого — вернуть none. */
  autoKey(): Promise<AccountResult<'kept' | 'picked' | 'none'>>;
  overview(): Promise<AccountResult<AccountOverview>>;
  /** from/to — даты YYYY-MM-DD (UTC); keyIds пусто — все ключи. */
  usage(q: { from: string; to: string; bucket: UsageBucket; keyIds: number[] }): Promise<AccountResult<AccountUsage>>;
}

export interface ChangeDocs {
  proposal: string;
  tasks: string;
  design: string;
  specs: { path: string; content: string }[];
}

/** Методы ядра, доступные окну (выполняются в utilityProcess). */
export interface CoreApi {
  dispatch(cmd: CoreCommand): Promise<{ runId: string }>;
  listRuns(): Promise<RunSummary[]>;
  getRun(id: string): Promise<RunFile | null>;
  getLog(id: string): Promise<string>;
  getDiff(id: string): Promise<DiffFile[]>;
  /** Изменённые файлы без содержимого — счётчик на вкладке «Код». */
  getChangedFiles(id: string): Promise<string[]>;
  getChangeDocs(id: string): Promise<ChangeDocs>;
  detectTools(): Promise<Record<ToolName, ToolInfo>>;
  testConnection(): Promise<ConnectionCheck[]>;
  detectProject(dir: string): Promise<ProjectCommands & { envFiles: string[]; isRepo: boolean; name: string }>;
  isDriving(id: string): Promise<boolean>;
  listBranches(id: string): Promise<{ branches: string[]; current: string | null; suggested: string | null }>;
  getAttachment(id: string, index: number): Promise<string | null>;
  detectCommandsAI(dir: string): Promise<AiCommands>;
  getProjectConfig(dir: string): Promise<ProjectConfig | null>;
  suggestMode(task: string): Promise<ModeSuggestion>;
  getVisualShot(id: string, file: string): Promise<string | null>;
  /** Проверка команд без запуска: скрипты npm/pnpm/yarn есть в package.json нужной папки. */
  checkCommands(dir: string, cmds: Record<string, string>): Promise<Record<string, CommandIssue[]>>;
  getKnowledge(dir: string): Promise<ProjectKnowledge>;
  saveKnowledge(dir: string, k: ProjectKnowledge): Promise<ProjectKnowledge>;
  refreshProfile(dir: string): Promise<ProjectKnowledge>;
  prReady(id: string): Promise<string | null>;
  getPrStatus(id: string): Promise<PrStatus | null>;
  getPrDetails(id: string): Promise<PrDetails | null>;
  getStorage(): Promise<StorageItem[]>;
  cleanStorage(id: StorageItem['id']): Promise<number>;
  startPreview(id: string): Promise<PreviewState>;
  stopPreview(id: string): Promise<void>;
  getPreview(id: string): Promise<PreviewState>;
  saveProjectConfig(dir: string, cfg: Omit<ProjectConfig, 'updatedAt'>): Promise<ProjectConfig>;
  listProjects(): Promise<ProjectListItem[]>;
  projectOverview(dir: string): Promise<ProjectOverview>;
  forgetProject(dir: string): Promise<void>;
  projectBranches(dir: string, fetch?: boolean): Promise<ProjectBranches>;
  cleanWorkingCopy(dir: string, how: 'stash' | 'discard'): Promise<{ files: number }>;
  checkEnvironment(dir: string): Promise<EnvCheck>;
  nextPartDraft(runId: string): Promise<NextPartDraft | null>;
  projectStats(dir: string): Promise<ProjectStats>;
  /** Чат менеджера прогона; thinking — ответ ещё готовится. */
  getManagerChat(id: string): Promise<{ messages: ManagerMessage[]; thinking: boolean }>;
  askManager(id: string, text: string): Promise<ManagerMessage[]>;
  resolveManagerAction(id: string, messageId: string, apply: boolean): Promise<ManagerMessage[]>;
  /** Чаты: разговор с агентом вне конвейера. Ответ приходит событиями chat.updated. */
  listChats(): Promise<ChatSummary[]>;
  getChat(id: string): Promise<{ chat: ChatFile; busy: boolean } | null>;
  createChat(o: { projectPath?: string; agent?: AgentKind; model?: string; edits?: boolean }): Promise<ChatFile>;
  updateChat(id: string, patch: Partial<Pick<ChatFile, 'title' | 'agent' | 'model' | 'edits'>>): Promise<ChatFile>;
  deleteChat(id: string): Promise<void>;
  sendChat(id: string, text: string, files?: { name: string; data: Uint8Array }[]): Promise<void>;
  stopChat(id: string): Promise<void>;
  /** Убрать сообщение из очереди, пока агент его не получил. */
  unqueueChat(id: string, messageId: string): Promise<ChatFile>;
  chatToTask(id: string): Promise<NextPartDraft>;
  /** Незакоммиченные изменения проекта чата относительно HEAD. */
  getChatDiff(id: string): Promise<DiffFile[]>;
  getChatChangedFiles(id: string): Promise<string[]>;
}

export type CoreMethod = keyof CoreApi;

export interface PurpleFlowBridge {
  core: CoreApi;
  onEvent(fn: (e: CoreEvent) => void): () => void;
  account: AccountApi;
  settings: {
    get(): Promise<PublicSettings>;
    set(patch: SettingsPatch): Promise<PublicSettings>;
    encryptionAvailable(): Promise<boolean>;
  };
  /** Выбор папки; title — заголовок диалога. */
  pickFolder(title?: string): Promise<string | null>;
  pickFile(): Promise<string | null>;
  openPath(p: string): Promise<void>;
  /** Вкладка «Браузер»: эмуляция телефона для webview по его webContentsId. */
  previewEmulate(webContentsId: number, mobile: boolean): Promise<void>;
  /** Кэш Chromium самого приложения (HTTP, код, GPU): размер и очистка. */
  appCache: { size(): Promise<number>; clear(): Promise<void> };
  /** Звук внимания и переход к прогону по клику на уведомление. */
  onChime(fn: () => void): () => void;
  onGo(fn: (runId: string) => void): () => void;
  testNotification(): Promise<void>;
  platform: string;
  /** Материал окна при запуске: нативное стекло ОС или непрозрачный фон. */
  material: 'vibrancy' | 'acrylic' | 'none';
  onMaterial(fn: (m: 'vibrancy' | 'acrylic' | 'none') => void): () => void;
}

// Сообщения main ↔ utilityProcess.
export type HostRequest =
  | { kind: 'init'; dataDir: string; promptsDir: string; settings: unknown }
  | { kind: 'settings'; settings: unknown }
  | { kind: 'call'; id: number; method: CoreMethod; args: unknown[] }
  | { kind: 'shutdown'; id: number };

export type HostMessage =
  | { kind: 'ready' }
  | { kind: 'event'; event: CoreEvent }
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string };
