import { useEffect, useState } from 'react';
import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';
import type { ProxyModels } from '../../../shared/models';
import { bridge } from './api';
import { MODEL_OPTIONS, mergeModelOptions } from './models';

/** Один запрос на всё окно: main кэширует ответ, здесь — только чтобы не дёргать IPC на каждый экран. */
let loaded: Promise<ProxyModels | null> | null = null;
let last: Record<AgentKind, DropOption<string>[]> = MODEL_OPTIONS;

/** Подсказки моделей: сразу встроенные, следом — с моделями AI-прокси, когда список придёт. */
export function useModelOptions(): Record<AgentKind, DropOption<string>[]> {
  const [options, setOptions] = useState(last);
  useEffect(() => {
    let alive = true;
    loaded ??= bridge.proxyModels().catch(() => null);
    void loaded.then((m) => {
      last = mergeModelOptions(m);
      if (alive) setOptions(last);
    });
    return () => {
      alive = false;
    };
  }, []);
  return options;
}
