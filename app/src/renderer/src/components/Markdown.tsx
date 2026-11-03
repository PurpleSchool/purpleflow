import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

/** Текст приходит и извне (комментарии PR): style растянул бы ссылку на всё окно, form ушла бы на чужой адрес. */
const PURIFY = { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] };

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source || '', { async: false }) as string, PURIFY), [source]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
