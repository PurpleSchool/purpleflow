import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { CoreEvent, RunFile } from '@purpleflow/core';
import type { PublicSettings } from '../../../shared/ipc';
import { bridge } from './api';
import { chatSummary, reducer, type State, type View } from './reducer';

export type { ProjectTab, SettingsTab, State, View } from './reducer';

/** Действия стабильны: кому нужны только они, тот не перерисовывается при каждом событии прогона. */
interface Actions {
  go(view: View): void;
  refreshTools(): Promise<void>;
  refreshRuns(): Promise<void>;
  loadRun(id: string): Promise<RunFile | null>;
  saveSettings(patch: Parameters<typeof bridge.settings.set>[0]): Promise<PublicSettings>;
  /** Перечитать настройки после входа, выхода или смены ключа в аккаунте. */
  reloadSettings(): Promise<PublicSettings>;
}

interface Ctx extends Actions {
  state: State;
}

const StoreCtx = createContext<Ctx | null>(null);
const ActionsCtx = createContext<Actions | null>(null);

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
    chats: [],
  });

  const refreshTools = useCallback(async () => {
    dispatch({ t: 'tools', tools: null, loading: true });
    try {
      dispatch({ t: 'tools', tools: await bridge.core.detectTools(), loading: false });
    } catch {
      dispatch({ t: 'tools', tools: null, loading: false });
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      dispatch({ t: 'runs', runs: await bridge.core.listRuns() });
    } catch {
      // Ядро ещё не поднялось или упало — не держим вечный загрузчик: пустой список, следующее событие обновит.
      dispatch({ t: 'runs', runs: [] });
    }
  }, []);

  const loadRun = useCallback(async (id: string) => {
    const r = await bridge.core.getRun(id);
    if (r) dispatch({ t: 'run', run: r });
    return r;
  }, []);

  const saveSettings = useCallback(async (patch: Parameters<typeof bridge.settings.set>[0]) => {
    const s = await bridge.settings.set(patch);
    dispatch({ t: 'settings', settings: s });
    return s;
  }, []);

  const reloadSettings = useCallback(async () => {
    const s = await bridge.settings.get();
    dispatch({ t: 'settings', settings: s });
    return s;
  }, []);

  useEffect(() => {
    const off = bridge.onEvent((e) => {
      if (e.type === 'run.updated') dispatch({ t: 'run', run: e.run });
      if (e.type === 'run.deleted') dispatch({ t: 'deleted', runId: e.runId });
      if (e.type === 'chat.updated') {
        dispatch({ t: 'chat', chat: chatSummary(e.chat, e.busy) });
      }
      if (e.type === 'chat.deleted') dispatch({ t: 'chatDeleted', chatId: e.chatId });
      for (const fn of listeners) fn(e);
    });
    void (async () => {
      const s = await bridge.settings.get();
      dispatch({ t: 'settings', settings: s });
      // Первый запуск: сначала вход в PurpleSchool (можно пропустить; в сборке без аккаунта его нет), затем настройка инструментов.
      if (!s.onboarded) dispatch({ t: 'view', view: { name: s.accountEnabled && !s.authPrompted && !s.account ? 'welcome' : 'settings' } });
      await refreshRuns();
      bridge.core
        .listChats()
        .then((chats) => dispatch({ t: 'chats', chats }))
        .catch(() => {});
      await refreshTools();
    })();
    return off;
  }, [refreshRuns, refreshTools]);

  // Dev-хук для скриншотов: window.__purpleflowGo({ name: 'run', runId }).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __purpleflowGo: (v: View) => void }).__purpleflowGo = (view) => dispatch({ t: 'view', view });
  }, []);

  // go стабилен: подписчики на него (уведомления, клавиши) не переподписываются на каждое обновление состояния.
  const go = useCallback((view: View) => dispatch({ t: 'view', view }), []);
  const actions = useMemo<Actions>(
    () => ({ go, refreshTools, refreshRuns, loadRun, saveSettings, reloadSettings }),
    [go, refreshTools, refreshRuns, loadRun, saveSettings, reloadSettings],
  );
  const value = useMemo<Ctx>(() => ({ state, ...actions }), [state, actions]);
  return (
    <ActionsCtx.Provider value={actions}>
      <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
    </ActionsCtx.Provider>
  );
}

export function useActions(): Actions {
  const a = useContext(ActionsCtx);
  if (!a) throw new Error('StoreProvider отсутствует');
  return a;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('StoreProvider отсутствует');
  return c;
}
