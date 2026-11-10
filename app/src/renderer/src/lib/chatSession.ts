// Сводка по сессии чата для вкладки «Сессия»: контекст и окружение агента.
import type { ChatFile, ChatMcpServer } from '@purpleflow/core';

export interface ChatSessionSummary {
  answers: number;
  /** Модель, которая ответила последней. */
  model?: string;
  /** Контекст после последнего ответа: занято и окно модели (окно — последнее известное). */
  context?: { used: number; window?: number; pct?: number };
  /** Контекст сжимался в этой сессии. */
  compacted: boolean;
  cwd?: string;
  version?: string;
  mcp?: ChatMcpServer[];
}

export function chatSession(chat: Pick<ChatFile, 'messages'>): ChatSessionSummary {
  const answers = chat.messages.filter((m) => m.role === 'assistant' && !m.pending);
  const compacted = answers.some((m) => m.parts?.some((p) => p.kind === 'notice' && p.key === 'compact'));

  // Сведения — из последнего ответа, где они есть: остановленный ход мог не дойти до итога.
  const last = <T>(pick: (m: (typeof answers)[number]) => T | undefined): T | undefined => {
    for (let i = answers.length - 1; i >= 0; i--) {
      const v = pick(answers[i]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const used = answers.at(-1)?.info?.context;
  const window = last((m) => m.info?.contextWindow);
  return {
    answers: answers.length,
    model: last((m) => m.model),
    context: used != null ? { used, window, pct: window ? Math.min(100, Math.round((used / window) * 100)) : undefined } : undefined,
    compacted,
    cwd: last((m) => m.info?.cwd),
    version: last((m) => m.info?.version),
    mcp: last((m) => m.info?.mcp),
  };
}

/** Состояние MCP-сервера по-русски и тон точки. */
export function mcpStatus(status: string): { label: string; tone: 'ok' | 'warn' | 'error' | 'idle' } {
  switch (status) {
    case 'connected':
      return { label: 'подключён', tone: 'ok' };
    case 'failed':
      return { label: 'не подключился', tone: 'error' };
    case 'needs-auth':
      return { label: 'нужен вход', tone: 'warn' };
    case 'pending':
      return { label: 'подключается', tone: 'idle' };
    default:
      return { label: status || 'неизвестно', tone: 'idle' };
  }
}
