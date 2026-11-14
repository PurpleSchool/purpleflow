import { useEffect, useMemo, useState } from 'react';
import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';
import type { ProxyModels } from '../../../shared/models';
import { bridge } from './api';
import { mergeModelOptions } from './models';
import { useStore } from './store';

/** Один запрос на всё окно: main кэширует ответ, здесь — только чтобы не дёргать IPC на каждый экран. */
let loaded: Promise<ProxyModels | null> | null = null;
let last: ProxyModels | null = null;

/**
 * Подсказки моделей: сразу встроенные, следом — с моделями AI-прокси, когда список придёт.
 * Модели, доступные только через прокси, видны всегда — с пометкой; выбор без подписки перехватывает ModelInput.
 */
export function useModelOptions(directory?: string): Record<AgentKind, DropOption<string>[]> {
  const [remote, setRemote] = useState(last);
  const { state } = useStore();
  const bin = state.settings?.toolPaths.opencode;
  const [openCode, setOpenCode] = useState<DropOption<string>[]>([]);
  useEffect(() => {
    let alive = true;
    let pending = false;
    setOpenCode([{ value: '', label: 'Загрузка моделей OpenCode…', disabled: true }]);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const ids = await bridge.core.openCodeModels(directory);
        if (alive)
          setOpenCode(
            ids.length
              ? ids.map((id) => ({ value: id, label: id }))
              : [{ value: '', label: 'В OpenCode нет доступных моделей', disabled: true }],
          );
      } catch {
        if (alive)
          setOpenCode([
            {
              value: '',
              label: 'Не удалось загрузить модели OpenCode',
              hint: 'Проверьте путь к CLI и конфигурацию OpenCode. Можно ввести модель вручную.',
              disabled: true,
            },
          ]);
      } finally {
        pending = false;
      }
    };
    void load();
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
    };
  }, [directory, bin]);
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
  return useMemo(() => ({ ...mergeModelOptions(remote), opencode: openCode }), [remote, openCode]);
}
