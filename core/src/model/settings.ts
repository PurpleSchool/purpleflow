// Настройки ядра, инструменты и роли агентов.

export type ToolName = 'git' | 'claude' | 'codex' | 'opencode' | 'agy' | 'openspec';

export interface ToolInfo {
  name: ToolName;
  path: string | null;
  version: string | null;
  error?: string;
}

export interface ToolInstallResult {
  name: ToolName;
  ok: boolean;
  info?: ToolInfo;
  error?: string;
}

export interface NodeInfo {
  path: string | null;
  version: string | null;
}

export interface NodeInstallResult {
  ok: boolean;
  info?: NodeInfo;
  error?: string;
}

export type Role = 'planner' | 'executor' | 'reviewer';

/** CLI-агент, который выполняет роль. */
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'agy';

/**
 * Уровни рассуждений (effort), которые понимает CLI агента: claude --effort, codex -c model_reasoning_effort.
 * У opencode уровни свои у каждого провайдера — списка нет, выбор не показываем.
 */
export const EFFORTS: Record<AgentKind, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: [],
  // agy: суффикс модели (gemini-3.8-flash-high); xhigh есть не у всех моделей — тогда имя без суффикса.
  agy: ['low', 'medium', 'high', 'xhigh'],
};

/** Уровень, если агент его понимает; иначе undefined — флаг не передаётся, решает CLI. */
export function effortFor(agent: AgentKind, effort: string | undefined): string | undefined {
  return effort && EFFORTS[agent].includes(effort) ? effort : undefined;
}

/**
 * Модели ролей; visual — модель claude для визуальной проверки (пусто — как у исполнителя-claude),
 * manager — модель менеджера прогона, scan — модель сканирования проекта (пусто — как у служебных вызовов).
 */
export type Models = Record<Role, string> & { visual?: string; manager?: string; scan?: string };

/** Уровень рассуждений по ролям; нет — как в настройках CLI. */
export type Efforts = Partial<Record<Role, string>>;

export const DEFAULT_AGENTS: Record<Role, AgentKind> = { planner: 'claude', executor: 'claude', reviewer: 'codex' };

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'opencode', 'agy'];

/** Включены, пока человек не выбрал сам: opencode и agy — по желанию, их провайдеры и вход настраивают отдельно. */
export const DEFAULT_ENABLED: AgentKind[] = ['claude', 'codex'];

/** Включённые в настройках CLI-агенты; пусто или не задано — claude и codex. */
export function enabledAgents(s: { enabledAgents?: AgentKind[] }): AgentKind[] {
  const list = AGENT_KINDS.filter((a) => s.enabledAgents?.includes(a));
  return list.length ? list : [...DEFAULT_ENABLED];
}

/** Агент, если он включён, иначе — включённый другой: выключенный CLI роли не выполняет. */
export function enabledAgent(s: { enabledAgents?: AgentKind[] }, a: AgentKind): AgentKind {
  const on = enabledAgents(s);
  return on.includes(a) ? a : on[0];
}

/**
 * Агенты: роли конвейера плюс визуальная проверка (по умолчанию claude) и менеджер прогона
 * и сканирование проекта — команды и профиль (оба по умолчанию — claude, если он установлен, иначе codex).
 */
export type Agents = Partial<Record<Role, AgentKind>> & { visual?: AgentKind; manager?: AgentKind; scan?: AgentKind };

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
  efforts?: Efforts;
  /** MCP PurpleSchool для картинок, видео и озвучки в чате: есть, когда включён в настройках аккаунта и есть ключ. */
  media?: { url: string; key: string };
  /** Картинок нет — что предложить, если человек просит нарисовать: войти в PurpleSchool или включить их в настройках. */
  mediaOffer?: 'signup' | 'enable';
  /** Агент на роль; по умолчанию планировщик и исполнитель — claude, ревьюер — codex. */
  agents?: Agents;
  /** Какими CLI пользоваться: выключенный не запускается, даже если установлен. Пусто или не задано — claude и codex. */
  enabledAgents?: AgentKind[];
  /**
   * Как claude авторизуется без прокси: 'login' — собственный вход Claude Code
   * (ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL из окружения игнорируются), 'env' — ключ из окружения.
   */
  claudeAuth?: 'login' | 'env';
  /**
   * Подключать собственные настройки агентов пользователя (~/.claude, ~/.codex): MCP-серверы, скиллы, плагины, CLAUDE.md.
   * Хуки claude при этом выключены. По умолчанию включено.
   */
  userConfig?: boolean;
  /** Сколько прогонов агенты ведут одновременно (остальные ждут в очереди). По умолчанию 2. */
  maxParallel?: number;
  /** Таймаут одной стадии агента, минуты. */
  agentTimeoutMin: number;
  /** Таймаут команды тестов, минуты. */
  testTimeoutMin: number;
}

export interface ConnectionCheck {
  agent: AgentKind;
  ok: boolean;
  model: string;
  durationMs: number;
  reply?: string;
  error?: string;
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
