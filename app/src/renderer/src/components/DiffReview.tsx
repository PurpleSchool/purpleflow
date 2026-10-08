import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor, loader, type DiffOnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { FileCode2, FilePlus2, FileMinus2, MessageSquarePlus, Sparkles, Trash2 } from 'lucide-react';
import { Markdown } from './Markdown';
import type { DiffFile, LineComment, ReviewItem } from '@psflow/core';
import { Button, TextArea } from './ui';

// Monaco из бандла, без CDN: приложение работает офлайн.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// Дифф только для чтения: языковые сервисы TS/JS не нужны и без своих воркеров дают ложные ошибки.
{
  const m = monaco as unknown as { languages?: { typescript?: TsApi }; typescript?: TsApi };
  const ts = m.typescript ?? m.languages?.typescript;
  for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
    d?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
  }
}
interface TsApi {
  typescriptDefaults?: { setDiagnosticsOptions?: (o: object) => void };
  javascriptDefaults?: { setDiagnosticsOptions?: (o: object) => void };
}

monaco.editor.defineTheme('psflow-night', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5f616a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b2a5f5' },
    { token: 'string', foreground: '9fcfb5' },
    { token: 'number', foreground: 'd9b97f' },
    { token: 'type', foreground: '9cc0dc' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#d4d5da',
    'editorLineNumber.foreground': '#3e4047',
    'editorLineNumber.activeForeground': '#a7a9b1',
    'editor.lineHighlightBackground': '#14151900',
    'editor.lineHighlightBorder': '#00000000',
    'editorGutter.background': '#00000000',
    'diffEditor.insertedTextBackground': '#74c4a01c',
    'diffEditor.removedTextBackground': '#df7e8d22',
    'diffEditor.insertedLineBackground': '#74c4a00c',
    'diffEditor.removedLineBackground': '#df7e8d0e',
    'diffEditorGutter.insertedLineBackground': '#74c4a018',
    'diffEditorGutter.removedLineBackground': '#df7e8d18',
    'diffEditor.diagonalFill': '#ffffff0c',
    'diffEditor.border': '#ffffff0e',
    'editor.selectionBackground': '#8a74ee40',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff22',
    'editorOverviewRuler.border': '#00000000',
    'editorWidget.background': '#1a1b1fee',
  },
});

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', py: 'python', go: 'go', rs: 'rust',
  yml: 'yaml', yaml: 'yaml', sh: 'shell', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', sql: 'sql', vue: 'html',
};
const langOf = (p: string) => LANG[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';

interface Props {
  files: DiffFile[];
  review?: { blocking: ReviewItem[]; notes: ReviewItem[] };
  comments: LineComment[];
  onComments: (c: LineComment[]) => void;
  readOnly?: boolean;
  /** «Что изменилось»: сводка для приёмки; null — ещё готовится. */
  summary?: string | null;
}

type Marker = { line: number; kind: 'blocking' | 'note' | 'mine'; text: string; idx?: number };

export function DiffReview({ files, review, comments, onComments, readOnly, summary }: Props) {
  // Сначала код, потом файлы OpenSpec — человек смотрит в первую очередь на изменения проекта.
  const sorted = useMemo(
    () => [...files].sort((a, b) => Number(a.path.startsWith('openspec/')) - Number(b.path.startsWith('openspec/')) || a.path.localeCompare(b.path)),
    [files],
  );
  const [current, setCurrent] = useState<string | null>(sorted[0]?.path ?? null);
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const zones = useRef<string[]>([]);
  const decos = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!current || !sorted.some((f) => f.path === current)) setCurrent(sorted[0]?.path ?? null);
  }, [sorted, current]);

  const file = sorted.find((f) => f.path === current) ?? null;

  const markers: Marker[] = useMemo(() => {
    if (!file) return [];
    const m: Marker[] = [];
    for (const r of review?.blocking ?? []) if (r.file === file.path && r.line) m.push({ line: r.line, kind: 'blocking', text: r.message });
    for (const r of review?.notes ?? []) if (r.file === file.path && r.line) m.push({ line: r.line, kind: 'note', text: r.message });
    comments.forEach((c, idx) => c.file === file.path && m.push({ line: c.line, kind: 'mine', text: c.text, idx }));
    return m;
  }, [file, review, comments]);

  const countFor = (p: string) =>
    (review?.blocking.filter((r) => r.file === p).length ?? 0) + (review?.notes.filter((r) => r.file === p).length ?? 0) + comments.filter((c) => c.file === p).length;

  // Замечания — карточки прямо под строкой (view zones) + метки на полях.
  useEffect(() => {
    const ed = editorRef.current?.getModifiedEditor();
    if (!ed) return;
    ed.changeViewZones((acc) => {
      for (const id of zones.current) acc.removeZone(id);
      zones.current = [];
      const byLine = new Map<number, Marker[]>();
      for (const m of markers) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
      for (const [line, list] of byLine) {
        const node = document.createElement('div');
        node.className = 'zone';
        for (const m of list) {
          const card = document.createElement('div');
          card.className = `zone-card z-${m.kind}`;
          const who = document.createElement('b');
          who.textContent = m.kind === 'blocking' ? 'Ревьюер · блокирует' : m.kind === 'note' ? 'Ревьюер · заметка' : 'Вы';
          const txt = document.createElement('span');
          txt.textContent = m.text;
          card.append(who, txt);
          node.append(card);
        }
        zones.current.push(acc.addZone({ afterLineNumber: line, heightInPx: 18 + list.length * 46, domNode: node, suppressMouseDown: true }));
      }
    });
    decos.current?.clear();
    decos.current = ed.createDecorationsCollection(
      markers.map((m) => ({
        range: new monaco.Range(m.line, 1, m.line, 1),
        options: { isWholeLine: true, className: `ln-${m.kind}`, glyphMarginClassName: `glyph glyph-${m.kind}` },
      })),
    );
  }, [markers, file?.path]);

  const onMount: DiffOnMount = (editor) => {
    editorRef.current = editor;
    const ed = editor.getModifiedEditor();
    ed.onMouseDown((e) => {
      if (readOnly) return;
      const t = e.target.type;
      const T = monaco.editor.MouseTargetType;
      if ((t === T.GUTTER_GLYPH_MARGIN || t === T.GUTTER_LINE_NUMBERS || t === T.GUTTER_LINE_DECORATIONS) && e.target.position) {
        setDraftLine(e.target.position.lineNumber);
        setDraft('');
        setTimeout(() => draftRef.current?.focus(), 30);
      }
    });
  };

  const addComment = () => {
    if (!file || !draftLine || !draft.trim()) return;
    onComments([...comments, { file: file.path, line: draftLine, text: draft.trim() }]);
    setDraftLine(null);
    setDraft('');
  };

  const jump = (line: number) => {
    const ed = editorRef.current?.getModifiedEditor();
    ed?.revealLineInCenter(line);
    ed?.setPosition({ lineNumber: line, column: 1 });
  };

  const fileItems = (review?.blocking ?? []).concat(review?.notes ?? []).filter((r) => !r.file || !r.line || !files.some((f) => f.path === r.file));

  return (
    <div className="diff">
      <aside className="diff-files">
        <div className="diff-files-head">
          <span>Файлы</span>
          <span className="muted">{files.length}</span>
        </div>
        <ul>
          {sorted.map((f) => {
            const n = countFor(f.path);
            const name = f.path.split('/').pop();
            const dir = f.path.slice(0, f.path.length - (name?.length ?? 0));
            return (
              <li key={f.path}>
                <button className={`file ${f.path === current ? 'is-on' : ''}`} onClick={() => { setCurrent(f.path); setDraftLine(null); }} title={f.path}>
                  <span className={`file-st st-${f.status}`}>
                    {f.status === 'A' ? <FilePlus2 size={14} /> : f.status === 'D' ? <FileMinus2 size={14} /> : <FileCode2 size={14} />}
                  </span>
                  <span className="file-name">
                    <span>{name}</span>
                    {dir && <small>{dir}</small>}
                  </span>
                  {n > 0 && <span className="file-n">{n}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="diff-main">
        {file ? (
          file.binary ? (
            <div className="diff-binary">Бинарный файл — дифф не показывается.</div>
          ) : (
            <DiffEditor
              key={file.path}
              original={file.original}
              modified={file.modified}
              language={langOf(file.path)}
              theme="psflow-night"
              onMount={onMount}
              options={{
                readOnly: true,
                originalEditable: false,
                renderSideBySide: true,
                glyphMargin: true,
                minimap: { enabled: false },
                fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, monospace",
                fontSize: 12.5,
                lineHeight: 21,
                scrollBeyondLastLine: false,
                renderOverviewRuler: false,
                hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6 },
                padding: { top: 16, bottom: 16 },
                smoothScrolling: true,
                automaticLayout: true,
              }}
            />
          )
        ) : (
          <div className="diff-binary">В ветке нет изменений.</div>
        )}
      </div>

      <aside className="diff-notes">
        {summary !== undefined && (
          <section className="change-summary">
            <h4><Sparkles size={14} /> Что изменилось</h4>
            {summary === null ? <p className="composer-hint"><span className="spinner" /> Готовлю сводку по диффу…</p> : <Markdown source={summary} className="summary-md" />}
          </section>
        )}
        {!readOnly && (
          <div className={`composer ${draftLine ? 'is-open' : ''}`}>
            {draftLine && file ? (
              <>
                <div className="composer-head">
                  <MessageSquarePlus size={15} />
                  <span>
                    {file.path.split('/').pop()}, строка {draftLine}
                  </span>
                </div>
                <TextArea
                  ref={draftRef}
                  rows={3}
                  placeholder="Что исправить в этой строке"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment();
                    if (e.key === 'Escape') setDraftLine(null);
                  }}
                />
                <div className="composer-actions">
                  <Button tone="quiet" onClick={() => setDraftLine(null)}>Отмена</Button>
                  <Button tone="primary" onClick={addComment} disabled={!draft.trim()}>Добавить</Button>
                </div>
              </>
            ) : (
              <p className="composer-hint">Нажмите на номер строки в новой версии файла, чтобы оставить замечание исполнителю.</p>
            )}
          </div>
        )}

        <NoteList title="Блокирующие" kind="blocking" items={review?.blocking ?? []} onJump={(r) => { if (r.file) setCurrent(r.file); if (r.line) setTimeout(() => jump(r.line!), 60); }} />
        <NoteList title="Заметки ревьюера" kind="note" items={review?.notes ?? []} onJump={(r) => { if (r.file) setCurrent(r.file); if (r.line) setTimeout(() => jump(r.line!), 60); }} />
        {comments.length > 0 && (
          <section className="notes">
            <h4>Ваши замечания <span className="muted">{comments.length}</span></h4>
            {comments.map((c, i) => (
              <div key={i} className="note n-mine">
                <button className="note-loc" onClick={() => { setCurrent(c.file); setTimeout(() => jump(c.line), 60); }}>
                  {c.file.split('/').pop()}:{c.line}
                </button>
                <p>{c.text}</p>
                {!readOnly && (
                  <button className="note-del" title="Удалить" onClick={() => onComments(comments.filter((_, k) => k !== i))}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
        {fileItems.length === 0 && !review?.blocking.length && !review?.notes.length && !comments.length && readOnly && (
          <p className="composer-hint">Замечаний нет.</p>
        )}
      </aside>
    </div>
  );
}

const ORIGIN: Record<NonNullable<ReviewItem['origin']>, { label: string; title: string }> = {
  unfixed: { label: 'не исправлено', title: 'Это замечание было и на прошлом ревью — исполнитель его не исправил или обошёл' },
  from_fix: { label: 'из‑за исправления', title: 'Появилось в коде, который исполнитель поменял, исправляя прошлые замечания' },
  new: { label: 'новое', title: 'В коде, который был и на прошлом ревью, — ревьюер заметил только сейчас' },
};

/** Пометка повторного ревью: ходит ли прогон по кругу. */
export function OriginTag({ origin }: { origin?: ReviewItem['origin'] }) {
  if (!origin) return null;
  return <span className={`origin-tag o-${origin}`} title={ORIGIN[origin].title}>{ORIGIN[origin].label}</span>;
}

function NoteList({ title, kind, items, onJump }: { title: string; kind: 'blocking' | 'note'; items: ReviewItem[]; onJump: (r: ReviewItem) => void }) {
  if (!items.length) return null;
  return (
    <section className="notes">
      <h4>{title} <span className="muted">{items.length}</span></h4>
      {items.map((r, i) => (
        <div key={i} className={`note n-${kind}`}>
          {r.file && (
            <button className="note-loc" onClick={() => onJump(r)}>
              {r.file.split('/').pop()}{r.line ? `:${r.line}` : ''}
            </button>
          )}
          <OriginTag origin={r.origin} />
          <p>{r.message}</p>
        </div>
      ))}
    </section>
  );
}
