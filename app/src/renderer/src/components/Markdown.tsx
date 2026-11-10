import { useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { markdownHtml } from '../lib/markdown';

/** Текст приходит и извне (комментарии PR): style растянул бы ссылку на всё окно, form ушла бы на чужой адрес. */
const PURIFY = { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] };

/** «Копировать» у блока кода: разметка приходит строкой, поэтому клик ловим на обёртке. */
function onCopy(e: MouseEvent<HTMLDivElement>) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.md-copy');
  const code = btn?.closest('.md-code')?.querySelector('pre');
  if (!btn || !code) return;
  e.stopPropagation();
  void navigator.clipboard.writeText(code.textContent ?? '').then(
    () => {
      // Иконка меняется на галочку на полторы секунды.
      btn.classList.add('is-done');
      btn.title = 'Скопировано';
      setTimeout(() => {
        btn.classList.remove('is-done');
        btn.title = 'Копировать';
      }, 1500);
    },
    () => {},
  );
}

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(markdownHtml(source), PURIFY), [source]);
  return <div className={`md ${className}`} onClick={onCopy} dangerouslySetInnerHTML={{ __html: html }} />;
}
