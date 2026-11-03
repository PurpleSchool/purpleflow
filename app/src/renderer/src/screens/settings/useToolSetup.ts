// Настройка одной кнопкой: поставить недостающие инструменты и проверить подключение агентов.
import type { ToolName } from '@purpleflow/core';
import { useState } from 'react';
import { bridge } from '../../lib/api';
import { useStore } from '../../lib/store';
import { toolNeeded } from '../../lib/tools';
import type { SettingsDraft } from './useSettingsDraft';

export const TOOL_NAMES: ToolName[] = ['git', 'claude', 'codex', 'openspec'];

export type ToolSetup = ReturnType<typeof useToolSetup>;

export function useToolSetup(draft: SettingsDraft) {
  const { state, refreshTools } = useStore();
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<ToolName | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ToolName, string>>>({});

  const tools = state.tools;
  const missing = tools ? TOOL_NAMES.filter((t) => toolNeeded(t, draft.agents) && (!tools[t].path || tools[t].error)) : [];

  const run = async () => {
    setRunning(true);
    setErrors({});
    try {
      // Сначала черновик: ядро должно видеть пути и роли с экрана, а не те, что были до правок.
      await draft.save();
      const found = await bridge.core.detectTools();
      const failed: Partial<Record<ToolName, string>> = {};
      for (const t of TOOL_NAMES) {
        if (!toolNeeded(t, draft.agents) || (found[t].path && !found[t].error)) continue;
        setCurrent(t);
        const r = await bridge.core.installTool(t);
        if (!r.ok) failed[t] = r.error;
      }
      setCurrent(null);
      setErrors(failed);
      await refreshTools();
      if (!Object.keys(failed).length) await draft.check();
    } catch (e) {
      draft.setError((e as Error).message);
    } finally {
      setCurrent(null);
      setRunning(false);
    }
  };

  return { running, current, errors, missing, run };
}
