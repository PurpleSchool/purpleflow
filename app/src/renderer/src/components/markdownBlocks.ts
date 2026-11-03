// Markdown по блокам: у каждого абзаца и пункта списка своя строка в файле — к ней привязывается замечание.
import { marked, type Token, type Tokens } from 'marked';

export interface Block {
  /** Строка начала блока в файле (с 1). */
  line: number;
  md: string;
  /** Начало текста блока без разметки — чтобы агент понял, о чём замечание. */
  quote: string;
}

const plain = (md: string) =>
  md
    .replace(/^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^#+\s+/, '')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

/** Разбивает Markdown на блоки верхнего уровня; списки — по пунктам, чтобы замечание можно было оставить к одной задаче. */
export function blocksOf(source: string): Block[] {
  const out: Block[] = [];
  let line = 1;
  const lines = (s: string) => (s.match(/\n/g) ?? []).length;
  for (const t of marked.lexer(source) as Token[]) {
    if (t.type === 'list') {
      let l = line;
      for (const item of (t as Tokens.List).items) {
        // У упорядоченного списка номер пункта уже в raw («3. …»), поэтому он отрисуется с правильным номером.
        out.push({ line: l, md: item.raw.trimEnd(), quote: plain(item.raw) });
        l += lines(item.raw);
      }
    } else if (t.type !== 'space' && t.type !== 'hr' && t.raw.trim()) {
      out.push({ line, md: t.raw.trimEnd(), quote: plain(t.raw) });
    }
    line += lines(t.raw);
  }
  return out;
}
