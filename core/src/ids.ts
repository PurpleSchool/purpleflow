import crypto from 'node:crypto';

const RU: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** kebab-case идентификатор изменения OpenSpec из текста задачи (с транслитерацией) + короткий суффикс. */
/** Ветки прогонов: purpleflow/<change-id>. До переименования прогоны создавали psflow/<change-id>. */
export const BRANCH_PREFIX = 'purpleflow/';
const LEGACY_BRANCH_PREFIX = 'psflow/';

export function runBranch(changeId: string): string {
  return BRANCH_PREFIX + changeId;
}

/** Ветка, созданная прогоном (локальная или origin/…), в том числе старым psflow/. */
export function isRunBranch(name: string): boolean {
  const n = name.replace(/^origin\//, '');
  return n.startsWith(BRANCH_PREFIX) || n.startsWith(LEGACY_BRANCH_PREFIX);
}

export function makeChangeId(task: string): string {
  const words = task
    .toLowerCase()
    .split('')
    .map((ch) => RU[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  let slug = '';
  for (const w of words) {
    if ((slug + '-' + w).length > 36) break;
    slug = slug ? `${slug}-${w}` : w;
  }
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${slug || 'task'}-${suffix}`;
}

export function makeTitle(task: string): string {
  const first = task.trim().split('\n')[0].trim();
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}
