import type {
  AgentKind, ManagerMessage, Models, AiCommands, EnvCheck, NextPartDraft, CommandIssue, PrStatus, ProjectKnowledge, ProjectListItem, ProjectOverview, ProjectStats, PrDetails, ProjectBranches, StorageItem, ConnectionCheck, ModeSuggestion, PreviewState, ProjectConfig, CoreCommand, CoreEvent, DiffFile, ProjectCommands, Role, RunFile, RunSummary, ToolInfo, ToolName,
} from '@psflow/core';

/** Настройки, как их видит окно: ключ прокси никогда не уходит в renderer. */
export interface PublicSettings {
  toolPaths: Partial<Record<ToolName, string>>;
  proxy: { baseUrl: string; codexBaseUrl: string; hasKey: boolean };
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
}

export interface SettingsPatch {
  toolPaths?: Partial<Record<ToolName, string>>;
  proxy?: { baseUrl?: string; codexBaseUrl?: string; apiKey?: string };
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
}

export type CoreMethod = keyof CoreApi;

export interface PsFlowBridge {
  core: CoreApi;
  onEvent(fn: (e: CoreEvent) => void): () => void;
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
