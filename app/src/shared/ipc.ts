import type {
  AgentKind, Models, AiCommands, CommandIssue, StorageItem, ConnectionCheck, ModeSuggestion, PreviewState, ProjectConfig, CoreCommand, CoreEvent, DiffFile, ProjectCommands, Role, RunFile, RunSummary, ToolInfo, ToolName,
} from '@psflow/core';

/** Настройки, как их видит окно: ключ прокси никогда не уходит в renderer. */
export interface PublicSettings {
  toolPaths: Partial<Record<ToolName, string>>;
  proxy: { baseUrl: string; codexBaseUrl: string; hasKey: boolean };
  models: Models;
  agents: Record<Role, AgentKind>;
  agentTimeoutMin: number;
  testTimeoutMin: number;
  onboarded: boolean;
  windowGlass: boolean;
  notify: boolean;
  sound: boolean;
  claudeAuth: 'login' | 'env';
}

export interface SettingsPatch {
  toolPaths?: Partial<Record<ToolName, string>>;
  proxy?: { baseUrl?: string; codexBaseUrl?: string; apiKey?: string };
  models?: Partial<Models>;
  agents?: Partial<Record<Role, AgentKind>>;
  agentTimeoutMin?: number;
  testTimeoutMin?: number;
  onboarded?: boolean;
  windowGlass?: boolean;
  notify?: boolean;
  sound?: boolean;
  claudeAuth?: 'login' | 'env';
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
  getChangeDocs(id: string): Promise<ChangeDocs>;
  detectTools(): Promise<Record<ToolName, ToolInfo>>;
  testConnection(): Promise<ConnectionCheck[]>;
  detectProject(dir: string): Promise<ProjectCommands & { envFiles: string[]; isRepo: boolean; name: string }>;
  isDriving(id: string): Promise<boolean>;
  listBranches(id: string): Promise<{ branches: string[]; current: string | null }>;
  getAttachment(id: string, index: number): Promise<string | null>;
  detectCommandsAI(dir: string): Promise<AiCommands>;
  getProjectConfig(dir: string): Promise<ProjectConfig | null>;
  suggestMode(task: string): Promise<ModeSuggestion>;
  getVisualShot(id: string, file: string): Promise<string | null>;
  /** Проверка команд без запуска: скрипты npm/pnpm/yarn есть в package.json нужной папки. */
  checkCommands(dir: string, cmds: Record<string, string>): Promise<Record<string, CommandIssue[]>>;
  getStorage(): Promise<StorageItem[]>;
  cleanStorage(id: StorageItem['id']): Promise<number>;
  startPreview(id: string): Promise<PreviewState>;
  stopPreview(id: string): Promise<void>;
  getPreview(id: string): Promise<PreviewState>;
  saveProjectConfig(dir: string, cfg: Omit<ProjectConfig, 'updatedAt'>): Promise<ProjectConfig>;
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
  pickFolder(): Promise<string | null>;
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
