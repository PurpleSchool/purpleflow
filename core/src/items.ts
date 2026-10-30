import type { ReviewItem } from './types.js';

/** Замечание одной строкой: «файл:строка — текст»; code — путь в обратных кавычках (для Markdown-промптов). */
export function formatItem(i: ReviewItem, code = false): string {
  const loc = i.file ? `${i.file}${i.line ? ':' + i.line : ''}` : '';
  return `${loc ? `${code ? '`' + loc + '`' : loc} — ` : ''}${i.message}`;
}

/** Пометка повторного ревью для лога и обратной связи исполнителю. */
export const originTag = (i: ReviewItem) =>
  i.origin === 'unfixed' ? '[не исправлено] ' : i.origin === 'from_fix' ? '[из‑за исправления] ' : '';
