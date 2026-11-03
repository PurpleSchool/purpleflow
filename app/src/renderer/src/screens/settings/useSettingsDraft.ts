// Черновик настроек, общий для вкладок «Инструменты» и «Модели»: правки копятся здесь и уходят одним «Сохранить».
import type { AgentKind, ConnectionCheck, Models, Role, ToolName } from '@purpleflow/core';
import { useEffect, useRef, useState } from 'react';
import { bridge } from '../../lib/api';
import { useStore } from '../../lib/store';
import { toolNeeded } from '../../lib/tools';
import { rebase } from './rebase';

export type SettingsDraft = ReturnType<typeof useSettingsDraft>;

export function useSettingsDraft() {
  const { state, saveSettings, refreshTools } = useStore();
  const s = state.settings;
  const [models, setModels] = useState<Models>({ planner: '', executor: '', reviewer: '', visual: '', manager: '' });
  const [agents, setAgents] = useState<Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind }>({
    planner: 'claude',
    executor: 'claude',
    reviewer: 'codex',
  });
  const [paths, setPaths] = useState<Partial<Record<ToolName, string>>>({});
  const [agentTimeout, setAgentTimeout] = useState(30);
  const [testTimeout, setTestTimeout] = useState(10);
  const [parallel, setParallel] = useState(2);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<ConnectionCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seen = useRef(s);
  const first = useRef(true);
  useEffect(() => {
    if (!s) return;
    const prev = first.current ? undefined : (seen.current ?? undefined);
    first.current = false;
    seen.current = s;
    setModels((d) => rebase(d, prev?.models, s.models));
    setAgents((d) => rebase(d, prev?.agents, s.agents));
    setPaths((d) => rebase(d, prev?.toolPaths, s.toolPaths));
    setAgentTimeout((d) => rebase(d, prev?.agentTimeoutMin, s.agentTimeoutMin));
    setTestTimeout((d) => rebase(d, prev?.testTimeoutMin, s.testTimeoutMin));
    setParallel((d) => rebase(d, prev ? (prev.maxParallel ?? 2) : undefined, s.maxParallel ?? 2));
  }, [s]);

  const flashSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({
        models,
        agents,
        toolPaths: paths,
        agentTimeoutMin: agentTimeout,
        testTimeoutMin: testTimeout,
        maxParallel: parallel,
      });
      flashSaved();
      await refreshTools();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Сохранить и отправить агентам короткий запрос. */
  const check = async () => {
    await save();
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await bridge.core.testConnection());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const tools = state.tools;
  const claudeFound = Boolean(tools?.claude.path && !tools.claude.error);
  const visualAgent = agents.visual ?? 'claude';
  const managerAgent = agents.manager ?? (tools && !claudeFound ? 'codex' : 'claude');
  const pickAgent = (id: Role | 'visual' | 'manager', a: AgentKind) => {
    if ((id === 'visual' ? visualAgent : id === 'manager' ? managerAgent : agents[id]) === a && (id !== 'manager' || agents.manager))
      return;
    setAgents({ ...agents, [id]: a });
    // Имя модели одного CLI другому не подходит — сбрасываем на модель по умолчанию.
    setModels({ ...models, [id]: '' });
  };

  const allFound =
    tools &&
    (['git', 'claude', 'codex', 'openspec'] as ToolName[]).every((t) => (tools[t].path && !tools[t].error) || !toolNeeded(t, agents));

  return {
    models,
    setModels,
    agents,
    setAgents,
    paths,
    setPaths,
    agentTimeout,
    setAgentTimeout,
    testTimeout,
    setTestTimeout,
    parallel,
    setParallel,
    saving,
    saved,
    flashSaved,
    error,
    setError,
    save,
    checking,
    checks,
    setChecks,
    check,
    claudeFound,
    visualAgent,
    managerAgent,
    pickAgent,
    allFound,
  };
}
