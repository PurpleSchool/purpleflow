// Настройки ядра, инструменты и роли агентов.

export type ToolName = 'git' | 'claude' | 'codex' | 'openspec';

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

export type Role = 'planner' | 'executor' | 'reviewer';

/** CLI-агент, который выполняет роль. */
export type AgentKind = 'claude' | 'codex';

/**
 * Модели ролей; visual — модель claude для визуальной проверки (пусто — как у исполнителя-claude),
 * manager — модель claude менеджера прогона (пусто — как у служебных вызовов).
 */
export type Models = Record<Role, string> & { visual?: string; manager?: string };

export const DEFAULT_AGENTS: Record<Role, AgentKind> = { planner: 'claude', executor: 'claude', reviewer: 'codex' };

/**
 * Агенты: роли конвейера плюс визуальная проверка (по умолчанию claude) и менеджер прогона
 * (по умолчанию — claude, если он установлен, иначе codex).
 */
export type Agents = Partial<Record<Role, AgentKind>> & { visual?: AgentKind; manager?: AgentKind };

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
  agents?: Agents;
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
  agent: 'claude' | 'codex';
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
