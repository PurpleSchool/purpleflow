import { useMemo, useRef, useState } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import type { LineComment } from '@purpleflow/core';
import { Markdown } from './Markdown';
import { Button, TextArea } from './ui';

interface Block {
  /** Строка начала блока в файле (с 1). */
  line: number;
  md: string;
  /** Начало текста блока без разметки — чтобы агент понял, о чём замечание. */
  quote: string;
}

const plain = (md: string) =>
  md.replace(/^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '').replace(/^#+\s+/, '').replace(/[`*_>#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);

/** Разбивает Markdown на блоки верхнего уровня; списки — по пунктам, чтобы замечание можно было оставить к одной задаче. */
function blocksOf(source: string): Block[] {
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

/**
 * Markdown, где к любому абзацу, заголовку или пункту списка можно оставить замечание.
 * Замечание — {file, line, quote, text}: уходит агенту вместе с возвратом.
 */
export function CommentableMarkdown({ file, source, comments, onComments, editable, className = '' }: {
  file: string; source: string; comments: LineComment[]; onComments: (c: LineComment[]) => void; editable: boolean; className?: string;
}) {
  const blocks = useMemo(() => blocksOf(source), [source]);
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const mine = comments.filter((c) => c.file === file);

  if (!editable && !mine.length) return <Markdown source={source} className={className} />;

  const add = (b: Block) => {
    if (!draft.trim()) return;
    onComments([...comments, { file, line: b.line, quote: b.quote, text: draft.trim() }]);
    setDraftLine(null);
    setDraft('');
  };

  return (
    <div className={`md cm ${className}`}>
      {blocks.map((b) => {
        const notes = mine.filter((c) => c.line === b.line);
        return (
          <div key={b.line} className={`cm-block ${notes.length ? 'has-notes' : ''} ${draftLine === b.line ? 'is-drafting' : ''}`}>
            <div className="cm-body">
              <Markdown source={b.md} className="cm-md" />
              {editable && draftLine !== b.line && (
                <button
                  className="cm-add"
                  title="Замечание к этому пункту"
                  onClick={() => {
                    setDraftLine(b.line);
                    setDraft('');
                    setTimeout(() => ref.current?.focus(), 30);
                  }}
                >
                  <MessageSquarePlus size={14} />
                </button>
              )}
            </div>
            {notes.map((c) => (
              <div key={comments.indexOf(c)} className="note n-mine cm-note">
                <p>{c.text}</p>
                {editable && (
                  <button className="note-del" title="Удалить" onClick={() => onComments(comments.filter((x) => x !== c))}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {draftLine === b.line && (
              <div className="composer is-open cm-composer">
                <TextArea
                  ref={ref}
                  rows={2}
                  placeholder="Что изменить в этом пункте"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(b);
                    if (e.key === 'Escape') setDraftLine(null);
                  }}
                />
                <div className="composer-actions">
                  <Button tone="quiet" onClick={() => setDraftLine(null)}>Отмена</Button>
                  <Button tone="primary" onClick={() => add(b)} disabled={!draft.trim()}>Добавить</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
