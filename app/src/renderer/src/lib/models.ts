import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';
import type { ProxyModels } from '../../../shared/models';

/**
 * Встроенные подсказки моделей: алиасы claude, Fable и линейка gpt-6 — их принимают и CLI, и AI-прокси PurpleSchool.
 * Остальные модели прокси подмешиваются из GET /public/ai-proxy/models (mergeModelOptions). Можно ввести и любое имя.
 */
export const MODEL_OPTIONS: Record<AgentKind, DropOption<string>[]> = {
  claude: [
    { value: 'claude-fable-5-2', label: 'claude-fable-5-2', hint: 'Fable 5.2 — самая сильная, сложные задачи и планирование' },
    { value: 'claude-fable-5-1', label: 'claude-fable-5-1', hint: 'Fable 5.1 — предыдущая Fable' },
    { value: 'opus', label: 'opus', hint: 'Сильная — планирование и сложный код' },
    { value: 'sonnet', label: 'sonnet', hint: 'Рабочая — баланс скорости и качества' },
    { value: 'haiku', label: 'haiku', hint: 'Быстрая и дешёвая — простые задачи' },
  ],
  codex: [
    { value: 'gpt-6-astra', label: 'gpt-6-astra', hint: 'Самая сильная — сложные задачи' },
    { value: 'gpt-6-sol', label: 'gpt-6-sol', hint: 'Рабочая — повседневный код' },
    { value: 'gpt-6-luna', label: 'gpt-6-luna', hint: 'Быстрая и дешёвая — простые задачи' },
  ],
};

/** Сначала встроенные (с нашими подсказками), за ними — остальные модели прокси с их названием в подсказке. */
export function mergeModelOptions(remote: ProxyModels | null): Record<AgentKind, DropOption<string>[]> {
  if (!remote) return MODEL_OPTIONS;
  const add = (base: DropOption<string>[], list: ProxyModels['anthropic']) => {
    const known = new Set(base.map((o) => o.value));
    return [
      ...base,
      ...list
        .filter((m) => !known.has(m.id))
        .map((m) => ({ value: m.id, label: m.id, hint: m.displayName && m.displayName !== m.id ? m.displayName : undefined })),
    ];
  };
  return { claude: add(MODEL_OPTIONS.claude, remote.anthropic), codex: add(MODEL_OPTIONS.codex, remote.openai) };
}
