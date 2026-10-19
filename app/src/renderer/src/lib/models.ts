import type { AgentKind } from '@psflow/core';
import type { DropOption } from '../components/Dropdown';

/**
 * Подсказки моделей в выпадающих списках: алиасы claude и линейка gpt-6 —
 * их принимают и CLI, и AI-прокси PurpleSchool. Можно ввести и любое другое имя.
 */
export const MODEL_OPTIONS: Record<AgentKind, DropOption<string>[]> = {
  claude: [
    { value: 'opus', label: 'opus', hint: 'Самая сильная — планирование и сложный код' },
    { value: 'sonnet', label: 'sonnet', hint: 'Рабочая — баланс скорости и качества' },
    { value: 'haiku', label: 'haiku', hint: 'Быстрая и дешёвая — простые задачи' },
  ],
  codex: [
    { value: 'gpt-6-astra', label: 'gpt-6-astra', hint: 'Самая сильная — сложные задачи' },
    { value: 'gpt-6-sol', label: 'gpt-6-sol', hint: 'Рабочая — повседневный код' },
    { value: 'gpt-6-luna', label: 'gpt-6-luna', hint: 'Быстрая и дешёвая — простые задачи' },
  ],
};
