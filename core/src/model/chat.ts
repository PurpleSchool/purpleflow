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
  /** Шаги субагента, запущенного этим вызовом. */
  sub?: ChatSubStep[];
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
  | { kind: 'question'; id?: string; questions: ChatQuestion[] };

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
  usage?: TokenUsage;
  /** Модель, которая ответила (из события запуска CLI). */
  model?: string;
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
}

export interface ChatFile {
  id: string;
  title: string;
  /** Папка проекта; нет — чат без проекта, агент работает во временной папке чата. */
  projectPath?: string;
  agent: AgentKind;
  /** Пусто — модель по умолчанию для этого агента из настроек. */
  model: string;
  /** Разрешить агенту менять файлы проекта; выключено — только чтение. */
  edits: boolean;
  /** Сессия CLI, которую продолжает следующий ход: claude --resume или codex exec resume. */
  session?: { agent: AgentKind; id: string };
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
}
