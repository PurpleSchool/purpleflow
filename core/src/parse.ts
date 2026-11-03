// Разбор ответов агентов и вывода проверок: всё чистое, без ввода-вывода.

import { jsonCandidates, parseJsonReply } from './json.js';
import type { ClarifyQuestion, ReviewItem } from './types.js';

/** Название изменения от планировщика: первая строка proposal.md вида «# Название». */
export function planTitle(proposal: string): string | null {
  const m = proposal.match(/^\s*#\s+(.+?)\s*$/m);
  if (!m || /^(why|what changes|impact)$/i.test(m[1])) return null;
  const t = m[1]
    .replace(/^(change|изменение)\s*:\s*/i, '')
    .replace(/[`*]/g, '')
    .trim();
  return t ? (t.length > 72 ? t.slice(0, 70) + '…' : t) : null;
}

/**
 * Команда «выбранных тестов» из раздела «## Checks» proposal.md: только тесты, которых касается задача.
 * Их гоняют до правок и после каждой попытки, полный набор — один раз перед приёмкой. «нет» или пусто — не выбраны.
 */
export function parseFocusTests(proposal: string): string | undefined {
  const lines = proposal.split('\n');
  const start = lines.findIndex((l) => /^##\s+Checks\s*$/i.test(l.trim()));
  if (start < 0) return undefined;
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = l.match(/`([^`\n]+)`/);
    if (m) {
      const cmd = m[1].trim();
      return cmd && cmd.length <= 400 ? cmd : undefined;
    }
  }
  return undefined;
}

/** Пункты раздела «## Next Parts» из proposal.md — следующие части большой задачи. */
export function parseNextParts(proposal: string): string[] {
  const lines = proposal.split('\n');
  const start = lines.findIndex((l) => /^##\s+Next Parts\s*$/.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const item = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (item) out.push(item[1].trim());
    else if (l.trim() && out.length && /^\s{2,}/.test(l)) out[out.length - 1] += ' ' + l.trim();
  }
  return out;
}

export function parseVerdicts(text: string): { index: number; verdict: 'confirmed' | 'rejected' | 'minor'; reason: string }[] | null {
  {
    const j = parseJsonReply<{ items?: unknown }>(text);
    if (!j || !Array.isArray(j.items)) return null;
    return j.items
      .map((x) => x as { index?: unknown; verdict?: unknown; reason?: unknown })
      .filter((x) => typeof x.index === 'number' && ['confirmed', 'rejected', 'minor'].includes(String(x.verdict)))
      .map((x) => ({ index: x.index as number, verdict: x.verdict as 'confirmed' | 'rejected' | 'minor', reason: String(x.reason ?? '') }));
  }
}

/** Имена упавших тестов из вывода раннера (Jest, Vitest, pytest, go test, node:test); null — не распознали. */
export function failedTestNames(output: string): string[] | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const names = new Set<string>();
  for (const l of text.split('\n')) {
    const m =
      l.match(/^\s*● (.+?)\s*$/) ?? // Jest
      l.match(/^\s*(?:FAIL|×|✗)\s+(\S+\s+>\s+.+?)(?:\s+\d+m?s)?\s*$/) ?? // Vitest
      l.match(/^FAILED (\S+)/) ?? // pytest
      l.match(/^\s*--- FAIL: (\S+)/) ?? // go test
      l.match(/^\s*not ok \d+ - (.+?)\s*$/); // node:test, TAP
    if (m && !/^Console$/.test(m[1])) names.add(m[1]);
  }
  return names.size ? [...names] : null;
}

/**
 * Число ошибок в выводе линтера или тестов — по итоговым строкам ESLint, tsc, Jest/Vitest, node:test, pytest, mocha, go.
 * null — если вывод не распознан.
 */
export function errorCount(output: string): number | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = [
    /✖\s*\d+\s+problems?\s*\((\d+)\s+errors?/g, // ESLint
    /Found (\d+) errors?/g, // tsc
    /Tests?:?\s+(\d+) failed/g, // Jest («Tests: 1 failed»), Vitest («Tests  1 failed | 3 passed»)
    /^[ℹ#]\s*fail (\d+)/gm, // node:test, TAP
    /(\d+) failed(?:,| in )/g, // pytest
    /(\d+) failing/g, // mocha
  ];
  for (const re of patterns) {
    const found = [...text.matchAll(re)];
    if (found.length) return found.reduce((n, m) => n + Number(m[1]), 0);
  }
  const goFails = text.match(/^--- FAIL/gm);
  if (goFails) return goFails.length;
  const lines = text.split('\n').filter((l) => /\berror\b/i.test(l)).length;
  return lines || null;
}

/** Визуальная проверка: причина, по которой проверить не удалось (поле "unverified"), иначе null. */
export function parseUnverified(text: string): string | null {
  try {
    const j = parseJsonReply<{ unverified?: unknown }>(text);
    return j && typeof j.unverified === 'string' && j.unverified.trim() ? j.unverified.trim().slice(0, 400) : null;
  } catch {
    return null;
  }
}

/** Вопросы уточнения из ответа планировщика (не больше 4). */
export function parseQuestions(text: string): ClarifyQuestion[] {
  try {
    const j = parseJsonReply<{ questions?: unknown }>(text);
    if (!j || !Array.isArray(j.questions)) return [];
    return j.questions
      .filter(
        (q): q is { q: string; options?: unknown; why?: unknown } =>
          Boolean(q) && typeof (q as { q?: unknown }).q === 'string' && (q as { q: string }).q.trim().length > 3,
      )
      .slice(0, 4)
      .map((q) => ({
        q: q.q.trim(),
        options: Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === 'string' && Boolean(o.trim())).slice(0, 4)
          : undefined,
        why: typeof q.why === 'string' && q.why.trim() ? q.why.trim() : undefined,
      }));
  } catch {
    return [];
  }
}

/** «shots» из JSON-ответа визуальной проверки. */
export function parseShots(text: string): { file: string; caption: string }[] {
  try {
    const j = parseJsonReply<Record<string, unknown>>(text);
    if (!j) return [];
    return Array.isArray(j.shots)
      ? j.shots
          .filter((x: { file?: unknown }) => typeof x?.file === 'string')
          .map((x: { file: string; caption?: unknown }) => ({ file: x.file, caption: String(x.caption ?? '') }))
      : [];
  } catch {
    return [];
  }
}

/** Число этапов большой задачи — разделы «## N.» в tasks.md. */
export function countPhases(tasks: string): number {
  return (tasks.match(/^##\s+\d+\./gm) ?? []).length;
}

export function firstLine(s: string): string {
  const line =
    s
      .trim()
      .split('\n')
      .find((l) => l.trim()) ?? '';
  return line.replace(/^[#>*\-\s]+/, '').slice(0, 160);
}

/** Достаём { blocking, notes } даже если модель обернула JSON в текст или ```json. */
export function parseReview(text: string): { blocking: ReviewItem[]; notes: ReviewItem[] } | null {
  for (const cand of jsonCandidates(text)) {
    try {
      const j = JSON.parse(cand);
      if (j && Array.isArray(j.blocking) && Array.isArray(j.notes)) {
        const norm = (x: unknown): ReviewItem =>
          typeof x === 'string'
            ? { file: null, line: null, message: x }
            : {
                file: (x as ReviewItem).file ?? null,
                line: typeof (x as ReviewItem).line === 'number' ? (x as ReviewItem).line : null,
                message: String((x as ReviewItem).message ?? JSON.stringify(x)),
                ...(['new', 'unfixed', 'from_fix'].includes((x as ReviewItem).origin as string)
                  ? { origin: (x as ReviewItem).origin }
                  : {}),
              };
        return { blocking: j.blocking.map(norm), notes: j.notes.map(norm) };
      }
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}
