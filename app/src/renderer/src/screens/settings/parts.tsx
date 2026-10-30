// Справочники и мелкие элементы вкладок настроек.
import type { AgentKind, Role, ToolName } from '@purpleflow/core';

export const TOOL_INFO: Record<ToolName, { title: string; install: string }> = {
  git: { title: 'Git', install: 'git-scm.com' },
  claude: { title: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { title: 'Codex CLI', install: 'npm i -g @openai/codex' },
  openspec: { title: 'OpenSpec', install: 'npm i -g @fission-ai/openspec' },
};
export const ROLES: { id: Role; title: string; text: string }[] = [
  { id: 'planner', title: 'Планировщик', text: 'Пишет proposal, tasks и дельты спецификаций' },
  { id: 'executor', title: 'Исполнитель', text: 'Реализует tasks.md и пишет тесты' },
  { id: 'reviewer', title: 'Ревьюер', text: 'Сверяет дифф с планом — лучше другая модель, чем у исполнителя' },
];
export const MODEL_PLACEHOLDER: Record<AgentKind, string> = { claude: 'opus, sonnet, haiku или полное имя', codex: 'по умолчанию codex' };
/** Выбор CLI-агента для роли. */
export function AgentSwitch({ label, value, onChange }: { label: string; value: AgentKind; onChange: (a: AgentKind) => void }) {
  return (
    <div className="segmented small" role="radiogroup" aria-label={`Агент: ${label}`}>
      {(['claude', 'codex'] as AgentKind[]).map((a) => (
        <button key={a} role="radio" aria-checked={value === a} className={value === a ? 'is-on' : ''} onClick={() => onChange(a)}>
          {a}
        </button>
      ))}
    </div>
  );
}
