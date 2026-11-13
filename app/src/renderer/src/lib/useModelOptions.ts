import { useEffect, useMemo, useState } from 'react';
import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';
import type { ProxyModels } from '../../../shared/models';
import { bridge } from './api';
import { mergeModelOptions } from './models';

/** Один запрос на всё окно: main кэширует ответ, здесь — только чтобы не дёргать IPC на каждый экран. */
let loaded: Promise<ProxyModels | null> | null = null;
let last: ProxyModels | null = null;

/**
 * Подсказки моделей: сразу встроенные, следом — с моделями AI-прокси, когда список придёт.
 * Модели, доступные только через прокси, видны всегда — с пометкой; выбор без подписки перехватывает ModelInput.
 */
export function useModelOptions(): Record<AgentKind, DropOption<string>[]> {
  const [remote, setRemote] = useState(last);
  useEffect(() => {
    let alive = true;
    loaded ??= bridge.proxyModels().catch(() => null);
    void loaded.then((m) => {
      last = m;
      if (alive) setRemote(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  return useMemo(() => mergeModelOptions(remote), [remote]);
}
