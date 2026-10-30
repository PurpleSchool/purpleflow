import type { AgentKind, Role, ToolName } from '@purpleflow/core';

/** Нужен ли инструмент: git и openspec — всегда, claude и codex — если на нём работает хотя бы одна роль. */
export function toolNeeded(t: ToolName, agents?: Partial<Record<Role, AgentKind>>): boolean {
  if (t !== 'claude' && t !== 'codex') return true;
  return !agents || Object.values(agents).includes(t);
}
