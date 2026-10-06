import type {
  ConnectionCheck, CoreCommand, CoreEvent, DiffFile, ProjectCommands, Role, RunFile, RunSummary, ToolInfo, ToolName,
} from '@psflow/core';

/** Настройки, как их видит окно: ключ прокси никогда не уходит в renderer. */
export interface PublicSettings {
  toolPaths: Partial<Record<ToolName, string>>;
  proxy: { baseUrl: string; codexBaseUrl: string; hasKey: boolean };
  models: Record<Role, string>;
  agentTimeoutMin: number;
  testTimeoutMin: number;
  onboarded: boolean;
  windowGlass: boolean;
}

export interface SettingsPatch {
  toolPaths?: Partial<Record<ToolName, string>>;
  proxy?: { baseUrl?: string; codexBaseUrl?: string; apiKey?: string };
  models?: Partial<Record<Role, string>>;
  agentTimeoutMin?: number;
  testTimeoutMin?: number;
  onboarded?: boolean;
  windowGlass?: boolean;
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
  detectProject(dir: string): Promise<ProjectCommands & { isRepo: boolean; name: string }>;
  isDriving(id: string): Promise<boolean>;
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
