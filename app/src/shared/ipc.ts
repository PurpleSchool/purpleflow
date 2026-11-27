// Контракт IPC: мост окна (preload), сообщения main ↔ utilityProcess ядра. Сам API ядра — CoreApi в @purpleflow/core.
import type { WindowTheme } from './themes';
import type { CoreApi, AgentKind, Efforts, Models, CoreEvent, Role, ToolName } from '@purpleflow/core';
import type { UpdateState } from './update';
import type { ProxyModels } from './models';
import type { Release } from './releases';
import type { SetupFailReason, SetupStep } from './usage-events';

export type { ChangeDocs, CoreApi } from '@purpleflow/core';

/** Настройки, как их видит окно: ключ прокси никогда не уходит в renderer. */
export interface PublicSettings {
  toolPaths: Partial<Record<ToolName, string>>;
  /** enabled — ключ подставляется агентам; выключенный ключ хранится, но не используется. */
  proxy: { baseUrl: string; codexBaseUrl: string; hasKey: boolean; enabled: boolean };
  /** MCP PurpleSchool для картинок, видео и озвучки в чате (нужны вход и ключ). */
  media: { enabled: boolean };
  models: Models;
  efforts: Efforts;
  agents: Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind; scan?: AgentKind };
  /** Включённые CLI: выключенный не выполняет ни одной роли, хотя бы один включён. */
  enabledAgents: AgentKind[];
  agentTimeoutMin: number;
  testTimeoutMin: number;
  maxParallel: number;
  onboarded: boolean;
  windowGlass: boolean;
  windowTheme: WindowTheme;
  notify: boolean;
  sound: boolean;
  claudeAuth: 'login' | 'env';
  userConfig: boolean;
  /** Сборка с аккаунтом PurpleSchool; false — PURPLEFLOW_ACCOUNT=off, вход и расход скрыты. */
  accountEnabled: boolean;
  /** Вход в PurpleSchool: null — не вошли. Токен в окно не передаётся. */
  account: { email: string; name: string; /** Аватар data URL; пусто — фото в профиле нет. */ photo: string } | null;
  authPrompted: boolean;
  /** Отчёты об ошибках и статистика использования — один выключатель. */
  diagnostics: boolean;
  /** Файл настроек сейчас не читается (например, нет доступа): показаны значения по умолчанию, сохранить нельзя. */
  unreadable: boolean;
}

export interface SettingsPatch {
  toolPaths?: Partial<Record<ToolName, string>>;
  proxy?: { baseUrl?: string; codexBaseUrl?: string; apiKey?: string; enabled?: boolean };
  media?: { enabled?: boolean };
  models?: Partial<Models>;
  efforts?: Efforts;
  agents?: Partial<Record<Role, AgentKind>> & { visual?: AgentKind; manager?: AgentKind; scan?: AgentKind };
  enabledAgents?: AgentKind[];
  agentTimeoutMin?: number;
  testTimeoutMin?: number;
  maxParallel?: number;
  onboarded?: boolean;
  windowGlass?: boolean;
  windowTheme?: WindowTheme;
  notify?: boolean;
  sound?: boolean;
  claudeAuth?: 'login' | 'env';
  userConfig?: boolean;
  authPrompted?: boolean;
  diagnostics?: boolean;
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

/** Подтверждение почты кодом (POST /email-verification/request|confirm). Даты — ISO или null. */
export interface EmailVerification {
  email: string;
  isVerified: boolean;
  expiredAt: string | null;
  resendAvailableAt: string | null;
  attemptsRemaining: number;
}

/** Стартовый баланс за подтверждение почты (GET /public/ai-proxy/info-v2 → initialBalance). Объёмы — строки. */
export interface InitialBalance {
  status: 'NOT_ELIGIBLE' | 'AVAILABLE' | 'ACTIVE' | 'FINISHED';
  email: string;
  isEmailVerified: boolean;
  offer: { initialUnits: string; validityDays: number; models: { provider: string; modelName: string; displayName: string }[] };
  grant: InitialBalanceGrant | null;
}
export type TrialModel = InitialBalance['offer']['models'][number];
/** Модель картинок MCP PurpleSchool; price — цена картинки 1K в кредитах, если сервер её отдал. */
export interface MediaModel {
  id: string;
  price?: number;
}
export interface InitialBalanceGrant {
  grantId: number;
  initialUnits: string;
  remainingUnits: string;
  startsAt: string;
  expiresAt: string;
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
  /** Стартовый баланс; null — сервер программу не отдаёт. */
  initialBalance(): Promise<AccountResult<InitialBalance | null>>;
  /** Отправить код подтверждения на почту аккаунта. */
  requestEmailCode(): Promise<AccountResult<EmailVerification>>;
  confirmEmailCode(code: string): Promise<AccountResult<EmailVerification>>;
  /** Начислить стартовый баланс — после подтверждения почты. */
  claimInitialBalance(): Promise<AccountResult<InitialBalanceGrant>>;
  /** На балансе только пробные токены и нет подписки — модели программы; иначе null. */
  trialModels(): Promise<AccountResult<TrialModel[] | null>>;
  /** Модели картинок MCP PurpleSchool по ключу аккаунта (для настроек). */
  mediaModels(): Promise<AccountResult<{ models: MediaModel[]; default: string | null }>>;
  /** Есть ли непробный баланс (подписка или пакет): картинки рисуются только за него. */
  paidBalance(): Promise<AccountResult<boolean>>;
}

export type CoreMethod = keyof CoreApi;

/**
 * Методы ядра, которые окно может вызвать через мост. Record по всем ключам CoreApi: забытый или лишний метод —
 * ошибка компиляции; preload строит из него window.purpleflow.core, core-host — проверку входящих вызовов.
 */
export const CORE_METHODS: Record<CoreMethod, true> = {
  dispatch: true,
  initRepo: true,
  listRuns: true,
  getRun: true,
  getLog: true,
  getDiff: true,
  getChangedFiles: true,
  getChangeDocs: true,
  detectTools: true,
  installTool: true,
  detectNode: true,
  installNode: true,
  testConnection: true,
  detectProject: true,
  isDriving: true,
  listBranches: true,
  mergeCheck: true,
  getAttachment: true,
  detectCommandsAI: true,
  getProjectConfig: true,
  suggestMode: true,
  getVisualShot: true,
  checkCommands: true,
  getKnowledge: true,
  saveKnowledge: true,
  saveKnowledgeProfile: true,
  removeKnowledgeLesson: true,
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
  detectForge: true,
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
  getManagerImage: true,
  resolveManagerAction: true,
  listChats: true,
  getChat: true,
  createChat: true,
  updateChat: true,
  deleteChat: true,
  sendChat: true,
  allowChatMcp: true,
  grantChatFullAccess: true,
  answerChatPermission: true,
  stopChat: true,
  unqueueChat: true,
  chatToTask: true,
  getChatDiff: true,
  getChatChangedFiles: true,
  listChatFiles: true,
  chatWorkDir: true,
  controlChatBrowser: true,
  chatBrowserAvailable: true,
  readChatFile: true,
  getGitGraph: true,
  getGitCommitDiff: true,
  listChatSkills: true,
  chatDefaultModel: true,
  listOpencodeModels: true,
  listMcp: true,
  searchMcp: true,
  installMcp: true,
  removeMcp: true,
  copyMcp: true,
  updateMcp: true,
  checkMcp: true,
  searchSkills: true,
  installSkill: true,
  copySkill: true,
  removeSkill: true,
  listAgyModels: true,
  compactChat: true,
};

export const coreMethodNames = Object.keys(CORE_METHODS) as CoreMethod[];

/** Модель диктовки (whisper.cpp). */
export interface DictationModel {
  id: string;
  label: string;
  hint: string;
  /** Байт. */
  size: number;
}
export interface DictationStatus {
  /** whisper-cli есть в этой сборке. */
  engine: boolean;
  models: (DictationModel & { ready: boolean })[];
}

export interface PurpleFlowBridge {
  /** В этой сборке окно подключает отчёты об ошибках; отправку всё равно решает main. */
  reportsErrors: boolean;
  core: CoreApi;
  onEvent(fn: (e: CoreEvent) => void): () => void;
  account: AccountApi;
  settings: {
    get(): Promise<PublicSettings>;
    set(patch: SettingsPatch): Promise<PublicSettings>;
    encryptionAvailable(): Promise<boolean>;
    /** Файл настроек снова прочитался после ошибки — настройки нужно перечитать. */
    onRecovered(fn: () => void): () => void;
  };
  /** Модели AI-прокси PurpleSchool; null — список недоступен (нет сети и кэша или сборка без аккаунта). */
  proxyModels(): Promise<ProxyModels | null>;
  /** Выбор папки; title — заголовок диалога. */
  pickFolder(title?: string): Promise<string | null>;
  /** Папки скиллов и файлы команд — в корзину системы (только внутри каталогов скиллов агентов). */
  trashSkill(paths: string[]): Promise<void>;
  /** Диктовка: локальное распознавание речи (whisper.cpp). */
  dictation: {
    status(): Promise<DictationStatus>;
    download(id: string): Promise<DictationStatus>;
    cancel(id: string): Promise<void>;
    remove(id: string): Promise<DictationStatus>;
    /** Доступ к микрофону (macOS спрашивает один раз). */
    mic(): Promise<boolean>;
    /** WAV 16 кГц моно → текст. lang: ru, en или auto. */
    transcribe(wav: Uint8Array, model: string, lang: string): Promise<string>;
    /** Прогресс скачивания модели: 0…1. */
    onProgress(fn: (id: string, share: number) => void): () => void;
  };
  /** Путь на диске у перетащенного файла или папки; пусто — не с диска (например, из буфера). */
  pathForFile(file: File): string;
  pickFile(): Promise<string | null>;
  openPath(p: string): Promise<void>;
  /** Вкладка «Браузер»: эмуляция телефона для webview по его webContentsId. */
  previewEmulate(webContentsId: number, mobile: boolean): Promise<void>;
  /** Вкладка «Браузер»: страница открыла ссылку в новом окне — fromId (webContentsId страницы) и адрес новой вкладки. */
  onPreviewNewTab(fn: (fromId: number, url: string) => void): () => void;
  /** Браузер чата: вкладка (webview) готова — мост отдаёт её агенту; возвращает её id в CDP. */
  chatWebTab(chatId: string, webContentsId: number, reqId?: string): Promise<string | null>;
  /** Картинка из ответа MCP PurpleSchool по https-ссылке — байтами (CSP окна не пускает внешние картинки). */
  mediaFetch(url: string): Promise<{ mime: string; data: Uint8Array } | null>;
  /** Сохранить картинку из чата через системный диалог; путь к файлу или null — отменили. */
  mediaSave(data: Uint8Array, name: string): Promise<string | null>;
  /** Терминал панели чата: оболочка пользователя в PTY (main-процесс). */
  terminal: {
    open(o: { cwd: string; cols: number; rows: number }): Promise<number>;
    write(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): Promise<void>;
    kill(id: number): Promise<void>;
    onData(fn: (id: number, data: string) => void): () => void;
    onExit(fn: (id: number, code: number) => void): () => void;
  };
  /** Браузер чата: агент открыл, закрыл или выбрал вкладку. */
  onChatWeb(
    fn: (
      e:
        | { type: 'open'; chatId: string; url: string; reqId: string }
        | { type: 'close' | 'select'; chatId: string; targetId: string }
        | { type: 'size'; chatId: string; targetId: string; width: number; height: number },
    ) => void,
  ): () => void;
  /** Кэш Chromium самого приложения (HTTP, код, GPU): размер и очистка. */
  appCache: { size(): Promise<number>; clear(): Promise<void> };
  /** Звук внимания и переход к прогону по клику на уведомление. */
  onChime(fn: () => void): () => void;
  onGo(fn: (runId: string) => void): () => void;
  testNotification(): Promise<void>;
  /** Шаг настройки для статистики; с reason — шаг не удался. Неизвестные шаги и причины main отбрасывает. */
  setupStep(step: SetupStep, reason?: SetupFailReason): void;
  /** Автообновление: состояние и шаги, которые решает пользователь. */
  update: {
    state(): Promise<UpdateState>;
    onState(fn: (s: UpdateState) => void): () => void;
    /** Пользователь сам запустил проверку: показать снова то, что он скрыл. */
    onReveal(fn: () => void): () => void;
    check(): Promise<void>;
    download(): Promise<void>;
    install(): Promise<void>;
  };
  /** Новый issue на GitHub с версией приложения, ОС и версиями инструментов — в браузере пользователя. */
  reportBug(tools: { name: string; version?: string }[]): Promise<void>;
  /** «Что нового»: выпуски с GitHub и какая версия уже показана. */
  whatsNew: {
    releases(): Promise<{ releases: Release[]; error?: string }>;
    versions(): Promise<{ current: string; seen: string }>;
    /** Текущая версия показана — после следующего обновления покажем то, что новее. */
    seen(): Promise<void>;
  };
  platform: string;
  /** Материал окна при запуске: нативное стекло ОС или непрозрачный фон. */
  material: 'vibrancy' | 'acrylic' | 'none';
  /** Тема фона на момент открытия окна — чтобы первая отрисовка была уже в её цвете. */
  theme: WindowTheme;
  onMaterial(fn: (m: 'vibrancy' | 'acrylic' | 'none') => void): () => void;
}

// Сообщения main ↔ utilityProcess.
export type HostRequest =
  | { kind: 'init'; dataDir: string; promptsDir: string; settings: unknown; chatWeb?: { port: number; key: string } }
  | { kind: 'settings'; settings: unknown }
  | { kind: 'call'; id: number; method: CoreMethod; args: unknown[] }
  | { kind: 'shutdown'; id: number };

export type HostMessage =
  | { kind: 'ready' }
  | { kind: 'init-failed'; error: string }
  | { kind: 'event'; event: CoreEvent }
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string };
