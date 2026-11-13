// API ядра, доступное окну: каждый метод выполняется в utilityProcess и вызывается через IPC.
// Orchestrator реализует этот интерфейс; список методов для моста — CORE_METHODS в app/src/shared/ipc.ts.
import type { ChatFile, ChatSkill, ChatSummary } from './chat.js';
import type { PrDetails, PrStatus } from './pr.js';
import type {
  AiCommands,
  CommandIssue,
  EnvCheck,
  NextPartDraft,
  ProjectBranches,
  ProjectCommands,
  ProjectConfig,
  ProjectKnowledge,
  ProjectListItem,
  ProjectOverview,
  ProjectStats,
} from './project.js';
import type { CoreCommand } from './protocol.js';
import type { DiffFile, ManagerMessage, ModeSuggestion, PreviewState, RunFile, RunSummary } from './run.js';
import type {
  AgentKind,
  ConnectionCheck,
  NodeInfo,
  NodeInstallResult,
  StorageItem,
  ToolInfo,
  ToolInstallResult,
  ToolName,
} from './settings.js';

export interface ChangeDocs {
  proposal: string;
  tasks: string;
  design: string;
  specs: { path: string; content: string }[];
}

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
  /** Поставить недостающий инструмент; окно передаёт только имя, команда зашита в ядре. */
  installTool(name: ToolName): Promise<ToolInstallResult>;
  detectNode(): Promise<NodeInfo>;
  /** Поставить Node.js в свою папку: адрес и контрольная сумма зашиты в ядре. */
  installNode(): Promise<NodeInstallResult>;
  testConnection(): Promise<ConnectionCheck[]>;
  /** repoRoot — папка лежит внутри другого репозитория (не его корень); тогда isRepo = false. */
  detectProject(dir: string): Promise<ProjectCommands & { envFiles: string[]; isRepo: boolean; name: string; repoRoot?: string }>;
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
  /** images — скриншоты и макеты к вопросу; только изображения. */
  askManager(id: string, text: string, images?: { name: string; data: Uint8Array }[]): Promise<ManagerMessage[]>;
  /** Изображение из чата менеджера для показа в окне: data URL; null — файла нет или он не из этого чата. */
  getManagerImage(id: string, file: string): Promise<string | null>;
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
  /** Файлы проекта для «@» в поле ввода чата (пути от корня проекта). */
  listChatFiles(projectPath: string): Promise<string[]>;
  /** Скиллы и команды для «/»: из проекта и, если агенты видят настройки пользователя, из ~/.claude и ~/.codex. */
  listChatSkills(projectPath?: string): Promise<ChatSkill[]>;
  /** Сжать контекст сессии claude в чате (/compact); идёт в фоне, как ход. */
  compactChat(id: string): Promise<void>;
  /** Модель чата по умолчанию для агента (из настроек ролей); пусто — модель выбирает CLI. */
  chatDefaultModel(agent: AgentKind): Promise<string>;
  getChatChangedFiles(id: string): Promise<string[]>;
}
