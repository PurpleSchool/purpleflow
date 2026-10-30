// Чат: обычный разговор с агентом вне конвейера.

import type { AgentKind } from './settings.js';
import type { TokenUsage } from './run.js';

/** Шаг ответа: текст (Markdown) или вызов инструмента одной строкой. */
export type ChatPart = { kind: 'text'; text: string } | { kind: 'tool'; text: string };

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
