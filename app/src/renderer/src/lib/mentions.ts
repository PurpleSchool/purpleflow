// Подсказки в поле ввода чата: «@» — файл проекта, «/» — скилл или команда.
import type { ChatSkill } from '@purpleflow/core';

export interface MentionToken {
  kind: 'file' | 'skill';
  /** Что набрано после @ или /. */
  query: string;
  /** Где в тексте начинается @ или / и где кончается слово. */
  start: number;
  end: number;
}

/** Слово под курсором, если оно начинается с @ или / в начале строки или после пробела. */
export function tokenAt(text: string, caret: number): MentionToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const word = text.slice(start, caret);
  const kind = word[0] === '@' ? 'file' : word[0] === '/' ? 'skill' : null;
  if (!kind) return null;
  // «/» — только имя скилла: путь вроде /usr/bin подсказку не открывает.
  if (kind === 'skill' && !/^\/[\w:.-]*$/.test(word)) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { kind, query: word.slice(1), start, end };
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Файлы по запросу: сначала имя файла с начала, потом имя содержит, потом путь содержит, потом буквы по порядку. */
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: [number, string][] = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const b = base(lf);
    let score: number;
    if (b.startsWith(q)) score = 0;
    else if (b.includes(q)) score = 1;
    else if (lf.includes(q)) score = 2;
    else if (subsequence(lf, q)) score = 3;
    else continue;
    scored.push([score * 10_000 + f.length, f]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, f]) => f);
}

function subsequence(s: string, q: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

/** Скиллы по запросу: имя с начала, потом имя содержит, потом описание содержит. */
export function rankSkills(skills: ChatSkill[], query: string): ChatSkill[] {
  const q = query.toLowerCase();
  if (!q) return skills;
  const score = (s: ChatSkill) => {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    if (s.description?.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return skills
    .map((s) => [score(s), s] as const)
    .filter(([sc]) => sc >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .map(([, s]) => s);
}

/** Подставить выбранное вместо набранного слова; курсор — после вставки и пробела. */
export function applyMention(text: string, t: MentionToken, value: string): { text: string; caret: number } {
  const insert = `${t.kind === 'file' ? '@' : '/'}${value} `;
  const rest = text.slice(t.end).replace(/^ /, '');
  return { text: text.slice(0, t.start) + insert + rest, caret: t.start + insert.length };
}
