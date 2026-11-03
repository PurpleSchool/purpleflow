// Состояние окна: чистый редьюсер, без обращений к мосту — чтобы проверялся тестами.
import type { ChatFile, ChatSummary, RunFile, RunSummary, ToolInfo, ToolName, NextPartDraft } from '@purpleflow/core';
import type { PublicSettings } from '../../../shared/ipc';

export type ProjectTab = 'overview' | 'commands' | 'knowledge';
export type View =
  | { name: 'new'; project?: string; draft?: NextPartDraft }
  | { name: 'run'; runId: string }
  | { name: 'settings' }
  | { name: 'welcome' }
  /** Чат; без chatId — новый, создаётся с первым сообщением. */
  | { name: 'chat'; chatId?: string; project?: string }
  | { name: 'projects' }
  | { name: 'project'; path: string; tab?: ProjectTab };

export interface State {
  view: View;
  settings: PublicSettings | null;
  tools: Record<ToolName, ToolInfo> | null;
  toolsLoading: boolean;
  runs: RunSummary[];
  /** Список прогонов уже получен от ядра (при запуске ядро стартует не мгновенно). */
  runsLoaded: boolean;
  /** Полные run.json прогонов, которые открыты или обновлялись в этой сессии. */
  details: Record<string, RunFile>;
  /** Чаты, свежие сверху. */
  chats: ChatSummary[];
}

export type Action =
  | { t: 'view'; view: View }
  | { t: 'settings'; settings: PublicSettings }
  | { t: 'tools'; tools: Record<ToolName, ToolInfo> | null; loading: boolean }
  | { t: 'runs'; runs: RunSummary[] }
  | { t: 'run'; run: RunFile }
  | { t: 'deleted'; runId: string }
  | { t: 'chats'; chats: ChatSummary[] }
  | { t: 'chat'; chat: ChatSummary }
  | { t: 'chatDeleted'; chatId: string };

export function summarize(r: RunFile, runJsonPath = ''): RunSummary {
  return {
    id: r.id,
    title: r.title,
    changeId: r.changeId,
    projectPath: r.projectPath,
    branch: r.branch,
    status: r.status,
    next: r.next,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    runJsonPath,
    implAttemptsUsed: r.implAttemptsUsed,
    totals: r.totals,
    mode: r.mode,
  };
}

/** Строка чата в истории — как chatSummary в ядре: last — итог последнего ответа агента. */
export function chatSummary(c: ChatFile, busy: boolean): ChatSummary {
  const answer = [...c.messages].reverse().find((m) => m.role === 'assistant' && !m.pending);
  const last = answer ? (answer.error || answer.stopped ? 'error' : 'ok') : null;
  return { id: c.id, title: c.title, projectPath: c.projectPath, agent: c.agent, updatedAt: c.updatedAt, busy, last };
}

export function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'view':
      return { ...s, view: a.view };
    case 'settings':
      return { ...s, settings: a.settings };
    case 'tools':
      return { ...s, tools: a.tools ?? s.tools, toolsLoading: a.loading };
    case 'deleted': {
      const details = { ...s.details };
      delete details[a.runId];
      const view: View = s.view.name === 'run' && s.view.runId === a.runId ? { name: 'new' } : s.view;
      return { ...s, view, details, runs: s.runs.filter((r) => r.id !== a.runId) };
    }
    case 'chats':
      return { ...s, chats: a.chats };
    case 'chat':
      return { ...s, chats: [a.chat, ...s.chats.filter((c) => c.id !== a.chat.id)].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)) };
    case 'chatDeleted': {
      const view: View = s.view.name === 'chat' && s.view.chatId === a.chatId ? { name: 'chat' } : s.view;
      return { ...s, view, chats: s.chats.filter((c) => c.id !== a.chatId) };
    }
    case 'runs':
      return { ...s, runs: a.runs, runsLoaded: true };
    case 'run': {
      const idx = s.runs.findIndex((r) => r.id === a.run.id);
      const runs = [...s.runs];
      if (idx >= 0) runs[idx] = { ...summarize(a.run, runs[idx].runJsonPath) };
      else runs.unshift(summarize(a.run));
      return { ...s, runs, details: { ...s.details, [a.run.id]: a.run } };
    }
  }
}
