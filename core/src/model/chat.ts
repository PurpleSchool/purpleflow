// Чат: обычный разговор с агентом вне конвейера.

import type { AgentKind } from './settings.js';
import type { TokenUsage } from './run.js';

/** Состояние вызова инструмента: выполняется, успешно, с ошибкой. */
export type ToolStatus = 'running' | 'ok' | 'error';

export interface ChatTodo {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Вопрос агента человеку (AskUserQuestion): ответ уходит обычным сообщением. */
export interface ChatQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Шаг субагента внутри вызова Task/Agent. */
export interface ChatSubStep {
  text: string;
  id?: string;
  status?: ToolStatus;
}

export interface ChatToolPart {
  kind: 'tool';
  /** Инструмент и главный аргумент одной строкой. */
  text: string;
  /** ID вызова: по нему приходит результат. */
  id?: string;
  status?: ToolStatus;
  /** Подробности вызова: дифф правки, начало файла, команда целиком. */
  detail?: string;
  /** Начало вывода инструмента. */
  output?: string;
  /** codex отказал в вызове MCP без подтверждения — человек может разрешить его и попросить повторить. */
  approval?: { server: string; tool: string };
  /** Команду не пустила песочница («Operation not permitted»): в режиме правок человек может дать полный доступ. */
  sandboxDenied?: boolean;
  /** Шаги субагента, запущенного этим вызовом. */
  sub?: ChatSubStep[];
  /** Картинки, которые нарисовал MCP PurpleSchool (generate_image, get_image_task): ссылки на оригиналы — окно показывает их в ответе. */
  images?: string[];
}

/**
 * Шаг ответа: текст (Markdown), размышления, вызов инструмента, план агента,
 * служебное уведомление (повтор запроса, сжатие контекста, отказ в правах) или вопрос человеку.
 */
export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | ChatToolPart
  | { kind: 'todos'; items: ChatTodo[] }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; key?: string }
  | { kind: 'question'; id?: string; questions: ChatQuestion[] }
  | ChatPermissionPart
  | ChatOfferPart;

/**
 * Карточка-предложение под ответом: картинку не нарисовать без подписки (subscribe), без входа в PurpleSchool (signup)
 * или с выключенными картинками в настройках (enable).
 */
export interface ChatOfferPart {
  kind: 'offer';
  offer: 'subscribe' | 'signup' | 'enable';
}

/** Ответ человека на запрос разрешения; expired — ход кончился раньше ответа. */
export type PermissionState = 'pending' | 'once' | 'always' | 'denied' | 'expired';

/** Агент просит действие, которое режим «Правки» не пускает (agy спрашивает перед каждым действием): решает человек. */
export interface ChatPermissionPart {
  kind: 'permission';
  id: string;
  /** Действие одной строкой: «Bash git commit -m …». */
  text: string;
  /** Команда или путь целиком. */
  detail?: string;
  /** Почему режим его не пускает. */
  reason: string;
  state: PermissionState;
}

export interface ChatMcpServer {
  name: string;
  /** connected, failed, needs-auth… — как сообщил CLI. */
  status: string;
}

/** Что агент сообщил о сессии за ход: контекст, окружение. */
export interface ChatTurnInfo {
  /** Токенов контекста занято к концу хода. */
  context?: number;
  contextWindow?: number;
  /** Рабочая папка агента. */
  cwd?: string;
  /** Версия CLI. */
  version?: string;
  mcp?: ChatMcpServer[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  at: string;
  /** Текст человека; у ответа — склеенные текстовые шаги. */
  text: string;
  parts?: ChatPart[];
  /** Вложения сообщения человека — пути к сохранённым файлам. */
  attachments?: string[];
  /** Ответ ещё пишется. */
  pending?: boolean;
  /** Сообщение человека отправлено, пока агент отвечал: уйдёт агенту следующим ходом. */
  queued?: boolean;
  error?: string;
  stopped?: boolean;
  /** Файлы проекта, изменённые за этот ход (только для чата с правками в git-репозитории). */
  changedFiles?: string[];
  /** Ход в режиме правок упёрся в его ограничения: под ответом — «Дать полный доступ и повторить». */
  needsFullAccess?: boolean;
  usage?: TokenUsage;
  /** Модель, которая ответила (из события запуска CLI). */
  model?: string;
  /** С каким уровнем рассуждений дан ответ; нет — как в CLI. */
  effort?: string;
  /** Сколько ходов модели занял ответ. */
  turns?: number;
  durationMs?: number;
  info?: ChatTurnInfo;
}

/** Скилл или команда для «/» в чате. */
export interface ChatSkill {
  name: string;
  description?: string;
  /** SKILL.md или файл команды — его агент читает, когда человек вызывает скилл. */
  path: string;
  /** project — из папки проекта, user — из ~/.claude или ~/.codex. */
  source: 'project' | 'user';
  kind?: 'skill' | 'command';
  /** Какие агенты найдут его сами (без вызова через «/» в чате). */
  agents?: AgentKind[];
  /** Из плагина claude. */
  plugin?: string;
  /** Проектный, но не в git: в отдельной рабочей копии прогона его не будет. */
  untracked?: boolean;
  /** Все копии с этим именем из того же источника: скилл бывает в .agents/skills и ссылкой в .claude/skills. */
  paths?: string[];
}

/** Найденный в каталоге скилл: source — репозиторий (owner/repo), skill — имя скилла в нём. */
export interface SkillHit {
  id: string;
  name: string;
  source: string;
  skill: string;
  installs: number;
}

/** Где записан MCP-сервер: в проекте или у вас (для всех проектов). */
export type McpScope = 'project' | 'user';
/** Проверка сервера: подключился, не подключился, нужен вход, не знаем (выключен или агент не ответил). */
export interface McpStatus {
  agent: AgentKind;
  name: string;
  scope: McpScope;
  local?: boolean;
  status: 'connected' | 'failed' | 'needs-auth' | 'unknown';
}

/** MCP-сервер из настроек агента. Значения переменных и заголовков не передаются — только имена. */
export interface McpEntry {
  name: string;
  agent: AgentKind;
  scope: McpScope;
  transport: 'stdio' | 'http' | 'sse';
  /** Команда запуска целиком (stdio). */
  command?: string;
  url?: string;
  env: string[];
  headers: string[];
  /** claude: сервер этого проекта только у вас (в ~/.claude.json), а не в .mcp.json. */
  local?: boolean;
  disabled?: boolean;
}

/** Вариант установки сервера из реестра MCP. */
export interface McpInstall {
  kind: 'remote' | 'npm' | 'pypi';
  label: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  /** Что спросить у человека: переменные окружения (stdio) или заголовки (удалённый). */
  inputs: { key: string; kind: 'env' | 'header'; description?: string; required: boolean; secret: boolean; default?: string }[];
}

/** Сервер из реестра MCP. */
export interface McpHit {
  id: string;
  /** Короткое имя для настроек агента. */
  name: string;
  title?: string;
  description: string;
  version: string;
  installs: McpInstall[];
}

export interface ChatFile {
  id: string;
  title: string;
  /** Название взято из первого сообщения — после первого ответа модель предложит нормальное. Человек переименовал — флага нет. */
  autoTitle?: boolean;
  /** Модель сейчас придумывает название — окно показывает на месте названия заглушку. */
  titling?: boolean;
  /** Папка проекта; нет — чат без проекта, агент работает во временной папке чата. */
  projectPath?: string;
  agent: AgentKind;
  /** Пусто — модель по умолчанию для этого агента из настроек. */
  model: string;
  /** Уровень рассуждений; нет — как в настройках CLI (флаг не передаётся). */
  effort?: string;
  /** Разрешить агенту менять файлы проекта; выключено — только чтение. */
  edits: boolean;
  /**
   * Полный доступ (только вместе с правками): без песочницы — git, процессы, файлы вне проекта.
   * Без него правки ограничены папкой проекта: codex workspace-write, claude — песочница bash, opencode — запрет коммитов и kill.
   */
  fullAccess?: boolean;
  /** Сессия CLI, которую продолжает следующий ход: claude --resume или codex exec resume. */
  session?: { agent: AgentKind; id: string };
  /** MCP-инструменты, разрешённые codex в этом чате без подтверждения. */
  mcpAllow?: { server: string; tool: string }[];
  /** Разрешённые только на следующий ход codex. */
  mcpOnce?: { server: string; tool: string }[];
  /** Папки, добавленные в контекст чата: агент получает к ним доступ на чтение (claude и agy — --add-dir). */
  dirs?: string[];
  /** Действия agy, которые человек разрешил «в этом чате»: точная команда или путь (agyPermissionKey). */
  agyAllow?: string[];
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  projectPath?: string;
  agent: AgentKind;
  updatedAt: string;
  busy: boolean;
  /** Чем закончился последний ход: ok — ответил, error — ошибка или остановлен, null — сообщений ещё нет. */
  last: 'ok' | 'error' | null;
  /** Идёт генерация названия. */
  titling?: boolean;
}

/** Файл проекта для вкладки «Файлы» чата. */
export interface ChatFileContent {
  text: string;
  truncated: boolean;
  binary: boolean;
  size: number;
  /** Картинка или видео — байтами, окно покажет их через blob-URL; tooBig — больше предела, не отдаём. */
  media?: { mime: string; data?: Uint8Array; tooBig?: boolean };
}
