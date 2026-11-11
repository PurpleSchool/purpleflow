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

/**
 * Своё семейство агента — модели самого вендора: работают и по подписке пользователя, без прокси.
 * Остальные (например, Gemini у codex) прокси PurpleSchool отдаёт через совместимый API — только через него.
 */
const OWN_FAMILY: Record<AgentKind, RegExp> = { claude: /^claude-/, codex: /^(gpt-|o\d|codex-)/ };
const PROXY_ONLY_HINT = 'только через AI-прокси PurpleSchool';

/**
 * Сначала встроенные (с нашими подсказками), за ними — остальные модели прокси с их названием в подсказке.
 * viaProxy — агенты ходят через AI-прокси PurpleSchool: тогда видны и модели не своего семейства, с пометкой;
 * без прокси они скрыты — по своей подписке такая модель не запустится.
 */
export function mergeModelOptions(remote: ProxyModels | null, viaProxy: boolean): Record<AgentKind, DropOption<string>[]> {
  if (!remote) return MODEL_OPTIONS;
  const add = (agent: AgentKind, list: ProxyModels['anthropic']) => {
    const base = MODEL_OPTIONS[agent];
    const known = new Set(base.map((o) => o.value));
    const extra: DropOption<string>[] = [];
    for (const m of list) {
      if (known.has(m.id)) continue;
      const own = OWN_FAMILY[agent].test(m.id);
      if (!own && !viaProxy) continue;
      const name = m.displayName && m.displayName !== m.id ? m.displayName : '';
      const hint = own ? name : [name, PROXY_ONLY_HINT].filter(Boolean).join(' · ');
      extra.push({ value: m.id, label: m.id, hint: hint || undefined });
    }
    return [...base, ...extra];
  };
  return { claude: add('claude', remote.anthropic), codex: add('codex', remote.openai) };
}
