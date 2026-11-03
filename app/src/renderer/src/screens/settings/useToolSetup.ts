// Настройка одной кнопкой: поставить недостающие инструменты и проверить подключение агентов.
import type { NodeInfo, ToolName } from '@purpleflow/core';
import { useEffect, useState } from 'react';
import { bridge } from '../../lib/api';
import { useStore } from '../../lib/store';
import { toolNeeded } from '../../lib/tools';
import type { SettingsDraft } from './useSettingsDraft';

export const TOOL_NAMES: ToolName[] = ['git', 'claude', 'codex', 'openspec'];

export type SetupStep = ToolName | 'node';

export type ToolSetup = ReturnType<typeof useToolSetup>;

export function useToolSetup(draft: SettingsDraft) {
  const { state, refreshTools } = useStore();
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<SetupStep | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SetupStep, string>>>({});
  const [node, setNode] = useState<NodeInfo | null>(null);

  useEffect(() => {
    void bridge.core.detectNode().then(setNode);
  }, []);

  const tools = state.tools;
  const missing = tools ? TOOL_NAMES.filter((t) => toolNeeded(t, draft.agents) && (!tools[t].path || tools[t].error)) : [];

  // Git ставится средствами ОС, остальным нужен npm.
  const needsNode = missing.some((t) => t !== 'git');

  const run = async () => {
    setRunning(true);
    setErrors({});
    try {
      // Сначала черновик: ядро должно видеть пути и роли с экрана, а не те, что были до правок.
      await draft.save();
      const found = await bridge.core.detectTools();
      const failed: Partial<Record<SetupStep, string>> = {};
      const need = TOOL_NAMES.filter((t) => toolNeeded(t, draft.agents) && (!found[t].path || found[t].error));
      if (need.some((t) => t !== 'git') && !(await bridge.core.detectNode()).path) {
        setCurrent('node');
        const r = await bridge.core.installNode();
        if (r.ok) setNode(r.info ?? null);
        else failed.node = r.error;
      }
      for (const t of need) {
        // Без Node.js npm-пакеты не поставить: причина уже показана на его строке.
        if (failed.node && t !== 'git') continue;
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

  return { running, current, errors, missing, needsNode, node, run };
}
