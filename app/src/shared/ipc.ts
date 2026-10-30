// Контракт IPC: мост окна (preload), сообщения main ↔ utilityProcess ядра. Сам API ядра — CoreApi в @purpleflow/core.
import type { CoreApi, AgentKind, Models, CoreEvent, Role, ToolName } from '@purpleflow/core';

export type { ChangeDocs, CoreApi } from '@purpleflow/core';

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
  | {
      ok: false;
      error: string;
      /** unauthorized — токен больше не действует, нужен вход заново. */ code?: 'unauthorized' | 'exists' | 'rate' | 'network';
    };

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
  balance: {
    totalInitialUnits: string;
    usedUnits: string;
    usedPercentage: number;
    remainingUnits: string;
    nonRolloverRemainingUnits: string;
    averageDailyUnitsSpend: string;
    estimatedRemainingDays: number | null;
  };
  currentPlan: { title: string; priceMinor: number; unitsPerMonth: string; nextPaymentAt: string; isAutoPaymentEnabled: boolean } | null;
}

export type UsageBucket = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export interface UsageModelSpend {
  modelName: string;
  unitsSpend: string;
  requestsCount: number;
}
/** Расход AI-прокси (GET /public/ai-proxy/usage). */
export interface AccountUsage {
  timeSeries: {
    bucketType: UsageBucket;
    period: { from: string; to: string };
    buckets: { date: string; totalUnitsSpend: string; modelUnitsSpend: UsageModelSpend[] }[];
  };
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

export type CoreMethod = keyof CoreApi;

/**
 * Методы ядра, которые окно может вызвать через мост. Record по всем ключам CoreApi: забытый или лишний метод —
 * ошибка компиляции; preload строит из него window.purpleflow.core, core-host — проверку входящих вызовов.
 */
export const CORE_METHODS: Record<CoreMethod, true> = {
  dispatch: true,
  listRuns: true,
  getRun: true,
  getLog: true,
  getDiff: true,
  getChangedFiles: true,
  getChangeDocs: true,
  detectTools: true,
  testConnection: true,
  detectProject: true,
  isDriving: true,
  listBranches: true,
  getAttachment: true,
  detectCommandsAI: true,
  getProjectConfig: true,
  suggestMode: true,
  getVisualShot: true,
  checkCommands: true,
  getKnowledge: true,
  saveKnowledge: true,
  refreshProfile: true,
  prReady: true,
  getPrStatus: true,
  getPrDetails: true,
  getStorage: true,
  cleanStorage: true,
  startPreview: true,
  stopPreview: true,
  getPreview: true,
  saveProjectConfig: true,
  listProjects: true,
  projectOverview: true,
  forgetProject: true,
  projectBranches: true,
  cleanWorkingCopy: true,
  checkEnvironment: true,
  nextPartDraft: true,
  projectStats: true,
  getManagerChat: true,
  askManager: true,
  resolveManagerAction: true,
  listChats: true,
  getChat: true,
  createChat: true,
  updateChat: true,
  deleteChat: true,
  sendChat: true,
  stopChat: true,
  unqueueChat: true,
  chatToTask: true,
  getChatDiff: true,
  getChatChangedFiles: true,
};

export const coreMethodNames = Object.keys(CORE_METHODS) as CoreMethod[];

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
