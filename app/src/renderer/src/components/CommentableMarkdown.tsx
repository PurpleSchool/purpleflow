import { useMemo, useRef, useState } from 'react';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import type { LineComment } from '@purpleflow/core';
import { Markdown } from './Markdown';
import { blocksOf, type Block } from './markdownBlocks';
import { Button, TextArea } from './ui';

/**
 * Markdown, где к любому абзацу, заголовку или пункту списка можно оставить замечание.
 * Замечание — {file, line, quote, text}: уходит агенту вместе с возвратом.
 */
export function CommentableMarkdown({
  file,
  source,
  comments,
  onComments,
  editable,
  className = '',
}: {
  file: string;
  source: string;
  comments: LineComment[];
  onComments: (c: LineComment[]) => void;
  editable: boolean;
  className?: string;
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
                  <Button tone="quiet" onClick={() => setDraftLine(null)}>
                    Отмена
                  </Button>
                  <Button tone="primary" onClick={() => add(b)} disabled={!draft.trim()}>
                    Добавить
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
