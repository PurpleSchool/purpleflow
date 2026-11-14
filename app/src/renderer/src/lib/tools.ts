import type { AgentKind, Role, ToolName } from '@purpleflow/core';

/** Git и OpenSpec нужны всегда, CLI-агент — если на нём работает хотя бы одна роль. */
export function toolNeeded(t: ToolName, agents?: Partial<Record<Role, AgentKind>>): boolean {
  if (t === 'git' || t === 'openspec') return true;
  return !agents || Object.values(agents).includes(t);
}
