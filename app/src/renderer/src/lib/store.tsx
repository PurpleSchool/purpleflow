import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { ChatFile, ChatSummary, CoreEvent, RunFile, RunSummary, ToolInfo, ToolName, NextPartDraft } from '@purpleflow/core';
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

interface State {
  view: View;
  settings: PublicSettings | null;
  tools: Record<ToolName, ToolInfo> | null;
  toolsLoading: boolean;
  runs: RunSummary[];
  /** Список прогонов уже получен от ядра (при запуске ядро стартует не мгновенно). */
  runsLoaded: boolean;
  /** Полные run.json прогонов, которые открыты или обновлялись в этой сессии. */
  details: Record<string, RunFile>;
  /** Последний открытый прогон — для пункта «Прогон» в навигации. */
  lastRunId: string | null;
  /** Чаты, свежие сверху. */
  chats: ChatSummary[];
}

type Action =
  | { t: 'view'; view: View }
  | { t: 'settings'; settings: PublicSettings }
  | { t: 'tools'; tools: Record<ToolName, ToolInfo> | null; loading: boolean }
  | { t: 'runs'; runs: RunSummary[] }
  | { t: 'run'; run: RunFile }
  | { t: 'deleted'; runId: string }
  | { t: 'chats'; chats: ChatSummary[] }
  | { t: 'chat'; chat: ChatSummary }
  | { t: 'chatDeleted'; chatId: string };

function summarize(r: RunFile, runJsonPath = ''): RunSummary {
  return {
    id: r.id, title: r.title, changeId: r.changeId, projectPath: r.projectPath, branch: r.branch, status: r.status,
    next: r.next, createdAt: r.createdAt, updatedAt: r.updatedAt, runJsonPath, implAttemptsUsed: r.implAttemptsUsed, totals: r.totals, mode: r.mode,
  };
}

/** Строка чата в истории — как chatSummary в ядре: last — итог последнего ответа агента. */
function chatSummary(c: ChatFile, busy: boolean): ChatSummary {
  const answer = [...c.messages].reverse().find((m) => m.role === 'assistant' && !m.pending);
  const last = answer ? (answer.error || answer.stopped ? 'error' : 'ok') : null;
  return { id: c.id, title: c.title, projectPath: c.projectPath, agent: c.agent, updatedAt: c.updatedAt, busy, last };
}

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'view':
      return { ...s, view: a.view, lastRunId: a.view.name === 'run' ? a.view.runId : s.lastRunId };
    case 'settings':
      return { ...s, settings: a.settings };
    case 'tools':
      return { ...s, tools: a.tools ?? s.tools, toolsLoading: a.loading };
    case 'deleted': {
      const details = { ...s.details };
      delete details[a.runId];
      const view: View = s.view.name === 'run' && s.view.runId === a.runId ? { name: 'new' } : s.view;
      return { ...s, view, details, runs: s.runs.filter((r) => r.id !== a.runId), lastRunId: s.lastRunId === a.runId ? null : s.lastRunId };
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
      return { ...s, runs: a.runs, runsLoaded: true, lastRunId: s.lastRunId ?? a.runs[0]?.id ?? null };
    case 'run': {
      const idx = s.runs.findIndex((r) => r.id === a.run.id);
      const runs = [...s.runs];
      if (idx >= 0) runs[idx] = { ...summarize(a.run, runs[idx].runJsonPath) };
      else runs.unshift(summarize(a.run));
      return { ...s, runs, details: { ...s.details, [a.run.id]: a.run } };
    }
  }
}

interface Ctx {
  state: State;
  go(view: View): void;
  refreshTools(): Promise<void>;
  refreshRuns(): Promise<void>;
  loadRun(id: string): Promise<RunFile | null>;
  saveSettings(patch: Parameters<typeof window.purpleflow.settings.set>[0]): Promise<PublicSettings>;
  /** Перечитать настройки после входа, выхода или смены ключа в аккаунте. */
  reloadSettings(): Promise<PublicSettings>;
}

const StoreCtx = createContext<Ctx | null>(null);

/** Подписчики на сырые события (лог агента идёт мимо React-состояния, прямо в xterm). */
const listeners = new Set<(e: CoreEvent) => void>();
export function onCoreEvent(fn: (e: CoreEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    view: { name: 'new' },
    settings: null,
    tools: null,
    toolsLoading: false,
    runs: [],
    runsLoaded: false,
    details: {},
    lastRunId: null,
    chats: [],
  });

  const refreshTools = useCallback(async () => {
    dispatch({ t: 'tools', tools: null, loading: true });
    try {
      dispatch({ t: 'tools', tools: await window.purpleflow.core.detectTools(), loading: false });
    } catch {
      dispatch({ t: 'tools', tools: null, loading: false });
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      dispatch({ t: 'runs', runs: await window.purpleflow.core.listRuns() });
    } catch {
      // Ядро ещё не поднялось или упало — не держим вечный загрузчик: пустой список, следующее событие обновит.
      dispatch({ t: 'runs', runs: [] });
    }
  }, []);

  const loadRun = useCallback(async (id: string) => {
    const r = await window.purpleflow.core.getRun(id);
    if (r) dispatch({ t: 'run', run: r });
    return r;
  }, []);

  const saveSettings = useCallback(async (patch: Parameters<typeof window.purpleflow.settings.set>[0]) => {
    const s = await window.purpleflow.settings.set(patch);
    dispatch({ t: 'settings', settings: s });
    return s;
  }, []);

  const reloadSettings = useCallback(async () => {
    const s = await window.purpleflow.settings.get();
    dispatch({ t: 'settings', settings: s });
    return s;
  }, []);

  useEffect(() => {
    const off = window.purpleflow.onEvent((e) => {
      if (e.type === 'run.updated') dispatch({ t: 'run', run: e.run });
      if (e.type === 'run.deleted') dispatch({ t: 'deleted', runId: e.runId });
      if (e.type === 'chat.updated') {
        dispatch({ t: 'chat', chat: chatSummary(e.chat, e.busy) });
      }
      if (e.type === 'chat.deleted') dispatch({ t: 'chatDeleted', chatId: e.chatId });
      for (const fn of listeners) fn(e);
    });
    void (async () => {
      const s = await window.purpleflow.settings.get();
      dispatch({ t: 'settings', settings: s });
      // Первый запуск: сначала вход в PurpleSchool (можно пропустить), затем настройка инструментов.
      if (!s.onboarded) dispatch({ t: 'view', view: { name: !s.authPrompted && !s.account ? 'welcome' : 'settings' } });
      await refreshRuns();
      window.purpleflow.core.listChats().then((chats) => dispatch({ t: 'chats', chats })).catch(() => {});
      await refreshTools();
    })();
    return off;
  }, [refreshRuns, refreshTools]);

  // Dev-хук для скриншотов: window.__purpleflowGo({ name: 'run', runId }).
  useEffect(() => {
    (window as unknown as { __purpleflowGo: (v: View) => void }).__purpleflowGo = (view) => dispatch({ t: 'view', view });
  }, []);

  const value = useMemo<Ctx>(
    () => ({ state, go: (view) => dispatch({ t: 'view', view }), refreshTools, refreshRuns, loadRun, saveSettings, reloadSettings }),
    [state, refreshTools, refreshRuns, loadRun, saveSettings, reloadSettings],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('StoreProvider отсутствует');
  return c;
}
