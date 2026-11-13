import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';
import type { ProxyModels } from '../../../shared/models';

/**
 * Встроенные подсказки моделей: алиасы claude, Fable и линейка gpt-6 (с gpt-6.1-terra) — их принимают и CLI, и AI-прокси PurpleSchool.
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
    { value: 'gpt-6-astra', label: 'gpt-6-astra', hint: 'Самая сильная — сложные задачи и планирование' },
    { value: 'gpt-6-sol', label: 'gpt-6-sol', hint: 'Сильная — планирование и сложный код' },
    { value: 'gpt-6.1-terra', label: 'gpt-6.1-terra', hint: 'Рабочая — баланс скорости и качества' },
    { value: 'gpt-6-luna', label: 'gpt-6-luna', hint: 'Быстрая и дешёвая — простые задачи' },
  ],
};

/**
 * Своё семейство агента — модели самого вендора: работают и по подписке пользователя, без прокси.
 * Остальные (например, Gemini у codex) прокси PurpleSchool отдаёт через совместимый API — только через него.
 */
const OWN_FAMILY: Record<AgentKind, RegExp> = { claude: /^claude-/, codex: /^(gpt-|o\d|codex-)/ };
/** Модель из списка, которая работает только через AI-прокси PurpleSchool. */
export function proxyOnly(options: DropOption<string>[], model: string): boolean {
  const v = model.trim();
  return Boolean(v) && options.some((o) => o.value === v && o.badge === PROXY_ONLY_BADGE);
}

/** Пометка моделей, которые работают только через AI-прокси, то есть только по подписке PurpleSchool. */
export const PROXY_ONLY_BADGE = 'подписка PurpleSchool';
export const PROXY_ONLY_TITLE =
  'Модель не от OpenAI и не от Anthropic: прокси PurpleSchool отдаёт её через совместимый API. Доступна только по подписке PurpleSchool.';

/**
 * Сначала встроенные (с нашими подсказками), за ними — остальные модели прокси с их названием в подсказке.
 * Модели не своего семейства видны всегда, с пометкой «подписка PurpleSchool»: без прокси выбор такой модели
 * ведёт ко входу или включению PurpleSchool (ModelInput), а не молча ломает запуск.
 */
export function mergeModelOptions(remote: ProxyModels | null): Record<AgentKind, DropOption<string>[]> {
  if (!remote) return MODEL_OPTIONS;
  const add = (agent: AgentKind, list: ProxyModels['anthropic']) => {
    const base = MODEL_OPTIONS[agent];
    const known = new Set(base.map((o) => o.value));
    const extra: DropOption<string>[] = [];
    for (const m of list) {
      if (known.has(m.id)) continue;
      const own = OWN_FAMILY[agent].test(m.id);
      const name = m.displayName && m.displayName !== m.id ? m.displayName : '';
      extra.push({
        value: m.id,
        label: m.id,
        hint: name || undefined,
        ...(own ? {} : { badge: PROXY_ONLY_BADGE, badgeTitle: PROXY_ONLY_TITLE }),
      });
    }
    return [...base, ...extra];
  };
  return { claude: add('claude', remote.anthropic), codex: add('codex', remote.openai) };
}
