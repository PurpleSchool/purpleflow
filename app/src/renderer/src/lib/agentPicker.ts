// Общий список «агент · модель» в поле чата: разделы по включённым агентам, поиск и своя модель.
import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';

export interface PickItem {
  agent: AgentKind;
  /** '' — модель по умолчанию из настроек ролей. */
  model: string;
  option?: DropOption<string>;
}

export interface PickSection {
  agent: AgentKind;
  items: PickItem[];
}

/**
 * Разделы по агентам в порядке включения. Пустой поиск — всё, с «по умолчанию» первым в каждом разделе; иначе — подходящие
 * модели, а пустые разделы скрыты. Только модели из списка: своё имя не вводится — опечатка ломала бы запуск агента.
 */
export function pickerSections(
  agents: AgentKind[],
  options: Record<AgentKind, DropOption<string>[]>,
  current: AgentKind,
  query: string,
): PickSection[] {
  const q = query.trim().toLowerCase();
  const sections: PickSection[] = agents.map((agent) => ({
    agent,
    items: [
      ...(q ? [] : [{ agent, model: '' }]),
      ...(options[agent] ?? [])
        // Ищем и по имени, и по человеческому названию: «sonnet 4» находит claude-sonnet-4-6.
        .filter((o) => !q || o.value.toLowerCase().includes(q) || modelName(o.value).toLowerCase().includes(q))
        // Псевдоним (opus) — та же модель, что последняя версия семейства (Claude Opus 5.5): двух одинаковых пунктов не нужно.
        .filter((o, _, all) => !shadowed(o.value, all))
        .sort(newestFirst)
        .map((option) => ({ agent, model: option.value, option })),
    ],
  }));
  return sections.filter((s) => s.items.length > 0);
}

const FAMILY_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  gpt: 'GPT',
  claude: 'Claude',
  qwen: 'Qwen',
  grok: 'Grok',
  kimi: 'Kimi',
  glm: 'GLM',
  llama: 'Llama',
  mistral: 'Mistral',
};

/** Семейство модели по началу имени: deepseek-v4-pro → deepseek. */
export const familyOf = (model: string): string => model.toLowerCase().split(/[-_.:/\s]/)[0] || model;
export const familyLabel = (family: string): string => FAMILY_LABEL[family] ?? family.charAt(0).toUpperCase() + family.slice(1);

const BRAND: Record<string, string> = {
  gpt: 'GPT',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  qwen: 'Qwen',
  llama: 'Llama',
  ai: 'AI',
  oss: 'OSS',
  vl: 'VL',
};

/**
 * Человеческое название модели из её имени: claude-sonnet-4-6 → Claude Sonnet 4.6, gpt-6.1-terra → GPT 6.1 Terra,
 * deepseek-v4-pro → DeepSeek V4 Pro. Соседние числа — версия через точку.
 */
export function modelName(id: string): string {
  // Дата снимка (claude-haiku-4-5-20251001) — не часть названия: она в подсказке.
  const parts = id
    .trim()
    .split(/[-_\s/]+/)
    .filter((p) => p && !DATE.test(p));
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(p) && prev && /^\d+(\.\d+)*$/.test(prev)) out[out.length - 1] = `${prev}.${p}`;
    else if (BRAND[p.toLowerCase()]) out.push(BRAND[p.toLowerCase()]);
    else if (/^v\d/i.test(p)) out.push(p.toUpperCase());
    else out.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ') || id;
}

const DATE = /^(20\d{2})(\d{2})(\d{2})$/;

/** Версия модели из имени: числа (4-6 → 4.6, v4.1 → 4.1) и дата снимка; псевдоним без версии (opus) — null. */
function release(id: string): { version: number[]; date: number } | null {
  const version: number[] = [];
  let date = 0;
  for (const part of id.toLowerCase().split(/[-_\s/]+/)) {
    if (DATE.test(part)) date = Number(part);
    else if (/^v?\d+(\.\d+)*$/.test(part)) version.push(...part.replace(/^v/, '').split('.').map(Number));
    else if (/^\D+\d+(\.\d+)*$/.test(part)) version.push(...part.replace(/^\D+/, '').split('.').map(Number));
  }
  return version.length || date ? { version, date } : null;
}

/**
 * Сначала новые: псевдонимы без версии (opus, sonnet — CLI всегда берёт последнюю), затем по версии и дате снимка
 * по убыванию. Одинаковые — в прежнем порядке.
 */
export function newestFirst(a: { value: string }, b: { value: string }): number {
  const x = release(a.value);
  const y = release(b.value);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < Math.max(x.version.length, y.version.length); i++) {
    const d = (y.version[i] ?? 0) - (x.version[i] ?? 0);
    if (d) return d;
  }
  return y.date - x.date;
}

/** Псевдоним семейства (opus, sonnet), у которого в списке есть конкретная версия, — дубль, его не показываем. */
function shadowed(value: string, all: DropOption<string>[]): boolean {
  const id = value.toLowerCase();
  if (release(id) || !/^[a-z]+$/.test(id)) return false;
  return all.some((o) => o.value !== value && o.value.toLowerCase().split(/[-_]/).includes(id) && release(o.value));
}
