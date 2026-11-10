// Markdown → HTML: GFM (таблицы, списки задач) и блоки кода с подсветкой, языком и кнопкой «Копировать».
import { Marked, Renderer } from 'marked';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  nginx,
  php,
  plaintext,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);
// Частые подписи блоков, которых нет среди алиасов highlight.js.
hljs.registerAliases(['vue', 'svelte'], { languageName: 'xml' });
hljs.registerAliases(['env', 'dotenv'], { languageName: 'bash' });
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });
hljs.registerAliases(['console', 'terminal'], { languageName: 'shell' });

/** Языки для блоков без подписи: угадываем только среди частых, чтобы не раскрашивать обычный текст. */
const AUTO = [
  'bash',
  'javascript',
  'typescript',
  'json',
  'python',
  'go',
  'rust',
  'java',
  'css',
  'xml',
  'yaml',
  'sql',
  'dockerfile',
  'diff',
];
/** Ниже этой уверенности блок без подписи остаётся простым текстом. */
const AUTO_MIN_RELEVANCE = 5;
/** Огромные блоки не угадываем и не раскрашиваем — это дорого на каждом обновлении потокового ответа. */
const MAX_HIGHLIGHT = 50_000;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Подсвеченный код и подпись языка; язык неизвестен — код как есть, подпись — как написал автор. */
export function highlightCode(text: string, lang?: string): { html: string; label: string } {
  const id = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (text.length <= MAX_HIGHLIGHT) {
    if (id && hljs.getLanguage(id)) return { html: hljs.highlight(text, { language: id, ignoreIllegals: true }).value, label: id };
    if (!id) {
      const r = hljs.highlightAuto(text, AUTO);
      if (r.language && r.relevance >= AUTO_MIN_RELEVANCE) return { html: r.value, label: r.language };
    }
  }
  return { html: escapeHtml(text), label: id };
}

/** Иконки lucide Copy и Check: разметка приходит строкой, поэтому компоненты React здесь не подходят. */
const svg = (body: string, cls: string) =>
  `<svg class="${cls}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const COPY_ICONS =
  svg(
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'md-copy-icon',
  ) + svg('<path d="M20 6 9 17l-5-5"/>', 'md-copy-done');

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    code({ text, lang }) {
      const { html, label } = highlightCode(text.replace(/\n$/, ''), lang);
      return (
        `<div class="md-code"><div class="md-code-head"><span class="md-code-lang">${escapeHtml(label)}</span>` +
        `<button type="button" class="md-copy" title="Копировать" aria-label="Копировать">${COPY_ICONS}</button></div>` +
        `<pre><code class="hljs">${html}</code></pre></div>\n`
      );
    },
    // Широкая таблица прокручивается сама, а не растягивает ленту.
    table(token) {
      return `<div class="md-table">${Renderer.prototype.table.call(this, token)}</div>\n`;
    },
  },
});

/** HTML без очистки: очищает компонент Markdown (DOMPurify нужен DOM). */
export const markdownHtml = (source: string) => md.parse(source || '', { async: false }) as string;
