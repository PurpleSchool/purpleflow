import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { DiffEditor, loader, type DiffOnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { ChevronRight, FileCode2, FilePlus2, FileMinus2, Folder, ListTree, List, MessageSquarePlus, Sparkles, Trash2 } from 'lucide-react';
import { Markdown } from './Markdown';
import { PillTabs } from './PillTabs';
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
  /** Выбранные на приёмке замечания ревьюера — уйдут исполнителю через «Исправить выбранные». */
  picked?: ReviewItem[];
  onPicked?: (items: ReviewItem[]) => void;
  /** Замечания визуальной проверки — на вкладке «Заметки» рядом с замечаниями ревьюера. */
  visualItems?: ReviewItem[];
  /** Вкладка «Код»/«Заметки» управляется снаружи (переключатель в шапке приёмки). */
  tab?: 'code' | 'notes';
  onTab?: (t: 'code' | 'notes') => void;
}

export const reviewKey = (r: ReviewItem) => `${r.file ?? ''}:${r.line ?? ''}:${r.message}`;

/** Галочка «исправить» у замечания ревьюера. */
export function PickBox({ item, picked, onPicked }: { item: ReviewItem; picked: ReviewItem[]; onPicked: (items: ReviewItem[]) => void }) {
  const on = picked.some((x) => reviewKey(x) === reviewKey(item));
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch pick-switch ${on ? 'is-on' : ''}`}
      title={on ? 'Убрать из исправлений' : 'Отдать исполнителю на исправление'}
      onClick={() => onPicked(on ? picked.filter((x) => reviewKey(x) !== reviewKey(item)) : [...picked, item])}
    >
      <i />
      <span>Исправить</span>
    </button>
  );
}

type Marker = { line: number; kind: 'blocking' | 'note' | 'mine'; text: string; idx?: number };

interface TreeDir {
  /** Полный путь папки (ключ для свёрнутых). */
  path: string;
  /** Подпись: одиночные вложенные папки склеены — «packages/api/src». */
  name: string;
  dirs: TreeDir[];
  files: DiffFile[];
  /** Сколько файлов внутри, включая вложенные папки. */
  count: number;
}

/** Дерево изменённых файлов: папки раньше файлов, openspec/ — в конце, цепочки из одной папки склеены. */
function buildTree(files: DiffFile[]): TreeDir {
  const root: TreeDir = { path: '', name: '', dirs: [], files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const p = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.find((d) => d.path === p);
      if (!next) node.dirs.push((next = { path: p, name: part, dirs: [], files: [], count: 0 }));
      node = next;
    }
    node.files.push(f);
  }
  const finish = (d: TreeDir): TreeDir => {
    d.dirs = d.dirs.map(finish);
    // Папка, где только одна вложенная папка и нет файлов, склеивается с ней.
    while (d.path && d.dirs.length === 1 && !d.files.length) {
      const only = d.dirs[0];
      Object.assign(d, { path: only.path, name: `${d.name}/${only.name}`, dirs: only.dirs, files: only.files });
    }
    d.dirs.sort((a, b) => Number(a.name.startsWith('openspec')) - Number(b.name.startsWith('openspec')) || a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
    d.count = d.files.length + d.dirs.reduce((n, x) => n + x.count, 0);
    return d;
  };
  return finish(root);
}

/** Файлы в порядке дерева — чтобы первым открывался верхний файл дерева. */
function treeOrder(d: TreeDir): DiffFile[] {
  return [...d.dirs.flatMap(treeOrder), ...d.files];
}

const TREE_KEY = 'psflow.diffTree';
const WIDTH_KEY = 'psflow.diffFilesWidth';
const MIN_W = 180;
const MAX_W = 640;

export function DiffReview({ files, review, comments, onComments, readOnly, summary, picked, onPicked, visualItems = [], tab: outerTab, onTab }: Props) {
  const [ownTab, setOwnTab] = useState<'code' | 'notes'>('code');
  const tab = outerTab ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const [sumOpen, setSumOpen] = useState(false);
  // Сначала код, потом файлы OpenSpec — человек смотрит в первую очередь на изменения проекта.
  const sorted = useMemo(
    () => [...files].sort((a, b) => Number(a.path.startsWith('openspec/')) - Number(b.path.startsWith('openspec/')) || a.path.localeCompare(b.path)),
    [files],
  );
  const tree = useMemo(() => buildTree(files), [files]);
  const [asTree, setAsTree] = useState(() => {
    try {
      return localStorage.getItem(TREE_KEY) !== 'list';
    } catch {
      return true;
    }
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Ширина панели файлов — тянется за правый край, запоминается. */
  const [filesW, setFilesW] = useState(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return v >= MIN_W && v <= MAX_W ? v : 232;
    } catch {
      return 232;
    }
  });
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = filesW;
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.min(MAX_W, Math.max(MIN_W, w0 + ev.clientX - x0));
      setFilesW(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-col-resizing');
      try {
        localStorage.setItem(WIDTH_KEY, String(w));
      } catch { /* без памяти о ширине */ }
    };
    document.body.classList.add('is-col-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const ordered = useMemo(() => (asTree ? treeOrder(tree) : sorted), [asTree, tree, sorted]);
  const [current, setCurrent] = useState<string | null>(ordered[0]?.path ?? null);
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const zones = useRef<string[]>([]);
  const decos = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!current || !ordered.some((f) => f.path === current)) setCurrent(ordered[0]?.path ?? null);
  }, [ordered, current]);

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


  const fileRow = (f: DiffFile, depth: number, withDir: boolean) => {
    const n = countFor(f.path);
    const name = f.path.split('/').pop();
    const dir = f.path.slice(0, f.path.length - (name?.length ?? 0));
    return (
      <li key={f.path}>
        <button className={`file ${f.path === current ? 'is-on' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={() => { setCurrent(f.path); setDraftLine(null); }} title={f.path}>
          <span className={`file-st st-${f.status}`}>
            {f.status === 'A' ? <FilePlus2 size={14} /> : f.status === 'D' ? <FileMinus2 size={14} /> : <FileCode2 size={14} />}
          </span>
          <span className="file-name">
            <span>{name}</span>
            {withDir && dir && <small>{dir}</small>}
          </span>
          {n > 0 && <span className="file-n">{n}</span>}
        </button>
      </li>
    );
  };

  const toggleDir = (p: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });

  const renderDir = (d: TreeDir, depth: number): ReactNode[] => {
    const inner = [...d.dirs.flatMap((x) => {
      const shut = collapsed.has(x.path);
      const n = treeOrder(x).reduce((k, f) => k + countFor(f.path), 0);
      return [
        <li key={`d:${x.path}`}>
          <button className={`file dir ${shut ? 'is-shut' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={() => toggleDir(x.path)} title={x.path}>
            <ChevronRight size={13} className="dir-caret" />
            <Folder size={14} className="dir-icon" />
            <span className="file-name"><span>{x.name}</span></span>
            {n > 0 ? <span className="file-n">{n}</span> : <span className="dir-count">{x.count}</span>}
          </button>
        </li>,
        ...(shut ? [] : renderDir(x, depth + 1)),
      ];
    }), ...d.files.map((f) => fileRow(f, depth, false))];
    return inner;
  };

  const jumpTo = (r: { file: string | null; line: number | null }) => {
    setTab('code');
    if (r.file) setCurrent(r.file);
    if (r.line) setTimeout(() => jump(r.line!), 80);
  };
  const noteCount = (review?.blocking.length ?? 0) + (review?.notes.length ?? 0) + visualItems.length + comments.length;
  const pickedN = picked?.length ?? 0;

  return (
    <div className="diff-wrap">
      {!outerTab && (
        <div className="diff-tabs">
        <PillTabs<'code' | 'notes'>
          className="tabs small"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'code', label: `Код · ${files.length}` },
            { id: 'notes', label: `Заметки · ${noteCount}`, extra: review?.blocking.length ? <span className="tab-badge is-bad">{review.blocking.length}</span> : undefined },
          ]}
        />
        {!readOnly && <span className="muted diff-tabs-hint">{tab === 'code' ? 'Клик по номеру строки — замечание исполнителю' : pickedN ? `Отмечено к исправлению: ${pickedN}` : 'Отметьте «исправить» у замечаний, которые нужно поправить'}</span>}
      </div>
      )}
    <div className={`diff ${tab === 'code' ? '' : 'is-hidden'}`} style={{ gridTemplateColumns: `${filesW}px minmax(0, 1fr)` }}>
      <div className="diff-files-resize" style={{ left: `calc(var(--s-4) + ${filesW}px - 1px)` }} onPointerDown={startResize} onDoubleClick={() => { setFilesW(232); try { localStorage.removeItem(WIDTH_KEY); } catch { /* без памяти */ } }} title="Потяните, чтобы изменить ширину; двойной клик — по умолчанию" />
      <aside className="diff-files">
        <div className="diff-files-head">
          <span>Файлы</span>
          <span className="muted">{files.length}</span>
          <span className="grow" />
          <button
            className="diff-files-mode"
            title={asTree ? 'Показать списком' : 'Показать деревом'}
            onClick={() => {
              const next = !asTree;
              setAsTree(next);
              try {
                localStorage.setItem(TREE_KEY, next ? 'tree' : 'list');
              } catch { /* без памяти о виде */ }
            }}
          >
            {asTree ? <List size={14} /> : <ListTree size={14} />}
          </button>
        </div>
        <ul>
          {asTree ? renderDir(tree, 0) : sorted.map((f) => fileRow(f, 0, true))}
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
        {!readOnly && draftLine && (
          <div className="composer is-open diff-composer">
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
            ) : null}
          </div>
        )}

      </div>
    </div>

      {tab === 'notes' && (
        <div className="diff-notes-page scroll">
        {summary !== undefined && (
          <section className={`change-summary ${sumOpen ? '' : 'is-clamped'}`}>
            <h4><Sparkles size={14} /> Что изменилось</h4>
            {summary === null ? <p className="composer-hint"><span className="spinner" /> Готовлю сводку по диффу…</p> : <Markdown source={summary} className="summary-md" />}
            {summary && <button className="link summary-more" onClick={() => setSumOpen(!sumOpen)}>{sumOpen ? 'Свернуть' : 'Показать полностью'}</button>}
          </section>
        )}
        <NoteList title="Блокирующие" kind="blocking" items={review?.blocking ?? []} picked={!readOnly ? picked : undefined} onPicked={onPicked} onJump={jumpTo} />
        <NoteList title="Заметки ревьюера" kind="note" items={review?.notes ?? []} picked={!readOnly ? picked : undefined} onPicked={onPicked} onJump={jumpTo} />
        {comments.length > 0 && (
          <section className="notes">
            <h4>Ваши замечания <span className="muted">{comments.length}</span></h4>
            {comments.map((c, i) => (
              <div key={i} className="note n-mine">
                <button className="note-loc" onClick={() => jumpTo(c)}>
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
        <NoteList title="Визуальная проверка" kind="note" items={visualItems} picked={!readOnly ? picked : undefined} onPicked={onPicked} onJump={jumpTo} />
        {noteCount === 0 && (
          <p className="composer-hint">Замечаний нет.</p>
        )}
        </div>
      )}
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

function NoteList({ title, kind, items, onJump, picked, onPicked }: { title: string; kind: 'blocking' | 'note'; items: ReviewItem[]; onJump: (r: ReviewItem) => void; picked?: ReviewItem[]; onPicked?: (items: ReviewItem[]) => void }) {
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
          {picked && onPicked && <PickBox item={r} picked={picked} onPicked={onPicked} />}
        </div>
      ))}
    </section>
  );
}
