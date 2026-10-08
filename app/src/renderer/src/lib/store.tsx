import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { CoreEvent, RunFile, RunSummary, ToolInfo, ToolName } from '@psflow/core';
import type { PublicSettings } from '../../../shared/ipc';

export type ProjectTab = 'overview' | 'commands' | 'knowledge';
export type View =
  | { name: 'new'; project?: string }
  | { name: 'run'; runId: string }
  | { name: 'settings' }
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
}

type Action =
  | { t: 'view'; view: View }
  | { t: 'settings'; settings: PublicSettings }
  | { t: 'tools'; tools: Record<ToolName, ToolInfo> | null; loading: boolean }
  | { t: 'runs'; runs: RunSummary[] }
  | { t: 'run'; run: RunFile }
  | { t: 'deleted'; runId: string };

function summarize(r: RunFile, runJsonPath = ''): RunSummary {
  return {
    id: r.id, title: r.title, changeId: r.changeId, projectPath: r.projectPath, branch: r.branch, status: r.status,
    next: r.next, createdAt: r.createdAt, updatedAt: r.updatedAt, runJsonPath, implAttemptsUsed: r.implAttemptsUsed, totals: r.totals, mode: r.mode,
  };
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
  saveSettings(patch: Parameters<typeof window.psflow.settings.set>[0]): Promise<PublicSettings>;
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
  });

  const refreshTools = useCallback(async () => {
    dispatch({ t: 'tools', tools: null, loading: true });
    try {
      dispatch({ t: 'tools', tools: await window.psflow.core.detectTools(), loading: false });
    } catch {
      dispatch({ t: 'tools', tools: null, loading: false });
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      dispatch({ t: 'runs', runs: await window.psflow.core.listRuns() });
    } catch {
      // Ядро ещё не поднялось или упало — не держим вечный загрузчик: пустой список, следующее событие обновит.
      dispatch({ t: 'runs', runs: [] });
    }
  }, []);

  const loadRun = useCallback(async (id: string) => {
    const r = await window.psflow.core.getRun(id);
    if (r) dispatch({ t: 'run', run: r });
    return r;
  }, []);

  const saveSettings = useCallback(async (patch: Parameters<typeof window.psflow.settings.set>[0]) => {
    const s = await window.psflow.settings.set(patch);
    dispatch({ t: 'settings', settings: s });
    return s;
  }, []);

  useEffect(() => {
    const off = window.psflow.onEvent((e) => {
      if (e.type === 'run.updated') dispatch({ t: 'run', run: e.run });
      if (e.type === 'run.deleted') dispatch({ t: 'deleted', runId: e.runId });
      for (const fn of listeners) fn(e);
    });
    void (async () => {
      const s = await window.psflow.settings.get();
      dispatch({ t: 'settings', settings: s });
      if (!s.onboarded) dispatch({ t: 'view', view: { name: 'settings' } });
      await refreshRuns();
      await refreshTools();
    })();
    return off;
  }, [refreshRuns, refreshTools]);

  // Dev-хук для скриншотов: window.__psflowGo({ name: 'run', runId }).
  useEffect(() => {
    (window as unknown as { __psflowGo: (v: View) => void }).__psflowGo = (view) => dispatch({ t: 'view', view });
  }, []);

  const value = useMemo<Ctx>(
    () => ({ state, go: (view) => dispatch({ t: 'view', view }), refreshTools, refreshRuns, loadRun, saveSettings }),
    [state, refreshTools, refreshRuns, loadRun, saveSettings],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('StoreProvider отсутствует');
  return c;
}
