// Дифф прогона или чата: дерево файлов, Monaco, комментарии к строкам и замечания ревью.
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { DiffFile, LineComment, ReviewItem } from '@purpleflow/core';
import { Check, MessageSquarePlus, Sparkles, Trash2 } from 'lucide-react';
import * as monaco from 'monaco-editor';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Markdown } from '../Markdown';
import { PillTabs } from '../PillTabs';
import { Button, TextArea } from '../ui';
import { FileList, type FilesView } from './FileList';
import { NoteList } from './ReviewNotes';
import { langOf } from './monaco';
import { buildTree, treeOrder } from './tree';
import { fingerprint, useViewed } from './viewed';

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
  /** Файлы по пунктам плана — вид «По плану» в списке файлов. */
  groups?: { title: string; files: string[] }[];
  /** Вкладка «Код»/«Заметки» управляется снаружи (переключатель в шапке приёмки). */
  tab?: 'code' | 'notes';
  onTab?: (t: 'code' | 'notes') => void;
  /** Ключ для отметок «Просмотрено» (id прогона); без него отметок нет. */
  viewedKey?: string;
}
type Marker = { line: number; kind: 'blocking' | 'note' | 'mine'; text: string; idx?: number };
const TREE_KEY = 'purpleflow.diffTree';
const WIDTH_KEY = 'purpleflow.diffFilesWidth';
const MIN_W = 180;
const MAX_W = 640;
export function DiffReview({
  files,
  review,
  comments,
  onComments,
  readOnly,
  summary,
  picked,
  onPicked,
  visualItems = [],
  tab: outerTab,
  onTab,
  groups,
  viewedKey,
}: Props) {
  const [ownTab, setOwnTab] = useState<'code' | 'notes'>('code');
  const tab = outerTab ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const [sumOpen, setSumOpen] = useState(false);
  // Сначала код, потом файлы OpenSpec — человек смотрит в первую очередь на изменения проекта.
  const sorted = useMemo(
    () =>
      [...files].sort(
        (a, b) => Number(a.path.startsWith('openspec/')) - Number(b.path.startsWith('openspec/')) || a.path.localeCompare(b.path),
      ),
    [files],
  );
  const tree = useMemo(() => buildTree(files), [files]);
  const [viewPref, setViewPref] = useState<FilesView>(() => {
    try {
      const v = localStorage.getItem(TREE_KEY);
      return v === 'list' ? 'list' : v === 'tree' ? 'tree' : 'plan';
    } catch {
      return 'plan';
    }
  });
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const planGroups = useMemo(
    () =>
      (groups ?? [])
        .map((g) => ({ ...g, items: g.files.map((f) => byPath.get(f)).filter((f): f is DiffFile => Boolean(f)) }))
        .filter((g) => g.items.length),
    [groups, byPath],
  );
  // «По плану» — когда группы посчитаны; иначе дерево.
  const view: FilesView = viewPref === 'plan' && !planGroups.length ? 'tree' : viewPref;
  const asTree = view === 'tree';
  const setView = (v: FilesView) => {
    setViewPref(v);
    try {
      localStorage.setItem(TREE_KEY, v);
    } catch {
      /* без памяти о виде */
    }
  };
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
      } catch {
        /* без памяти о ширине */
      }
    };
    document.body.classList.add('is-col-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const ordered = useMemo(
    () =>
      view === 'plan'
        ? [...planGroups.flatMap((g) => g.items), ...sorted.filter((f) => !planGroups.some((g) => g.items.includes(f)))]
        : asTree
          ? treeOrder(tree)
          : sorted,
    [view, asTree, tree, sorted, planGroups],
  );
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

  const viewed = useViewed(viewedKey);
  const prints = useMemo(() => new Map(files.map((f) => [f.path, fingerprint(f)])), [files]);
  const isViewed = (p: string) => viewed.enabled && viewed.marks[p] === prints.get(p);
  const viewedCount = viewed.enabled ? files.filter((f) => isViewed(f.path)).length : 0;
  /** Отметить текущий файл и перейти к следующему непросмотренному (по порядку списка, по кругу). */
  const toggleViewed = (p: string) => {
    const next = { ...viewed.marks };
    if (isViewed(p)) {
      delete next[p];
      viewed.save(next);
      return;
    }
    next[p] = prints.get(p) ?? '';
    viewed.save(next);
    if (p !== current) return;
    const i = ordered.findIndex((f) => f.path === p);
    const rest = [...ordered.slice(i + 1), ...ordered.slice(0, i)];
    const to = rest.find((f) => next[f.path] !== prints.get(f.path));
    if (to) {
      setCurrent(to.path);
      setDraftLine(null);
    }
  };
  // V — отметить просмотренным и дальше (не в полях ввода).
  const toggleRef = useRef(toggleViewed);
  toggleRef.current = toggleViewed;
  useEffect(() => {
    if (!viewed.enabled || tab !== 'code') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'v' && e.key.toLowerCase() !== 'м') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement;
      // Редактор диффа только для чтения — в нём V работает; в настоящих полях ввода — нет.
      if (!el.closest('.monaco-editor') && el.closest('input, textarea, [contenteditable]')) return;
      if (!current) return;
      e.preventDefault();
      toggleRef.current(current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewed.enabled, tab, current]);

  const markers: Marker[] = useMemo(() => {
    if (!file) return [];
    const m: Marker[] = [];
    for (const r of review?.blocking ?? []) if (r.file === file.path && r.line) m.push({ line: r.line, kind: 'blocking', text: r.message });
    for (const r of review?.notes ?? []) if (r.file === file.path && r.line) m.push({ line: r.line, kind: 'note', text: r.message });
    comments.forEach((c, idx) => c.file === file.path && m.push({ line: c.line, kind: 'mine', text: c.text, idx }));
    return m;
  }, [file, review, comments]);

  const countFor = (p: string) =>
    (review?.blocking.filter((r) => r.file === p).length ?? 0) +
    (review?.notes.filter((r) => r.file === p).length ?? 0) +
    comments.filter((c) => c.file === p).length;

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
        zones.current.push(
          acc.addZone({ afterLineNumber: line, heightInPx: 18 + list.length * 46, domNode: node, suppressMouseDown: true }),
        );
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
              {
                id: 'notes',
                label: `Заметки · ${noteCount}`,
                extra: review?.blocking.length ? <span className="tab-badge is-bad">{review.blocking.length}</span> : undefined,
              },
            ]}
          />
          {!readOnly && (
            <span className="muted diff-tabs-hint">
              {tab === 'code'
                ? 'Клик по номеру строки — замечание исполнителю'
                : pickedN
                  ? `Отмечено к исправлению: ${pickedN}`
                  : 'Отметьте «исправить» у замечаний, которые нужно поправить'}
            </span>
          )}
        </div>
      )}
      <div className={`diff ${tab === 'code' ? '' : 'is-hidden'}`} style={{ gridTemplateColumns: `${filesW}px minmax(0, 1fr)` }}>
        <div
          className="diff-files-resize"
          style={{ left: `calc(var(--s-4) + ${filesW}px - 1px)` }}
          onPointerDown={startResize}
          onDoubleClick={() => {
            setFilesW(232);
            try {
              localStorage.removeItem(WIDTH_KEY);
            } catch {
              /* без памяти */
            }
          }}
          title="Потяните, чтобы изменить ширину; двойной клик — по умолчанию"
        />
        <FileList
          files={files}
          sorted={sorted}
          tree={tree}
          planGroups={planGroups}
          view={view}
          onView={setView}
          current={current}
          onPick={(p) => {
            setCurrent(p);
            setDraftLine(null);
          }}
          countFor={countFor}
          isViewed={isViewed}
          viewedCount={viewed.enabled ? viewedCount : null}
        />

        <div className={`diff-main ${viewed.enabled && file ? 'has-head' : ''}`}>
          {viewed.enabled && file && (
            <div className="diff-file-head">
              <span className="diff-file-path" title={file.path}>
                {file.path}
              </span>
              <button
                className={`viewed-toggle ${isViewed(file.path) ? 'is-on' : ''}`}
                onClick={() => toggleViewed(file.path)}
                title={isViewed(file.path) ? 'Снять отметку' : 'Отметить просмотренным и перейти к следующему (V)'}
              >
                <span className="viewed-box">{isViewed(file.path) && <Check size={12} />}</span>
                Просмотрено
              </button>
            </div>
          )}
          {file ? (
            file.binary ? (
              <div className="diff-binary">Бинарный файл — дифф не показывается.</div>
            ) : (
              <DiffEditor
                key={file.path}
                original={file.original}
                modified={file.modified}
                language={langOf(file.path)}
                theme="purpleflow-night"
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
                    <Button tone="quiet" onClick={() => setDraftLine(null)}>
                      Отмена
                    </Button>
                    <Button tone="primary" onClick={addComment} disabled={!draft.trim()}>
                      Добавить
                    </Button>
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
              <h4>
                <Sparkles size={14} /> Что изменилось
              </h4>
              {summary === null ? (
                <p className="composer-hint">
                  <span className="spinner" /> Готовлю сводку по диффу…
                </p>
              ) : (
                <Markdown source={summary} className="summary-md" />
              )}
              {summary && (
                <button className="link summary-more" onClick={() => setSumOpen(!sumOpen)}>
                  {sumOpen ? 'Свернуть' : 'Показать полностью'}
                </button>
              )}
            </section>
          )}
          <NoteList
            title="Блокирующие"
            kind="blocking"
            items={review?.blocking ?? []}
            picked={!readOnly ? picked : undefined}
            onPicked={onPicked}
            onJump={jumpTo}
          />
          <NoteList
            title="Заметки ревьюера"
            kind="note"
            items={review?.notes ?? []}
            picked={!readOnly ? picked : undefined}
            onPicked={onPicked}
            onJump={jumpTo}
          />
          {comments.length > 0 && (
            <section className="notes">
              <h4>
                Ваши замечания <span className="muted">{comments.length}</span>
              </h4>
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
          <NoteList
            title="Визуальная проверка"
            kind="note"
            items={visualItems}
            picked={!readOnly ? picked : undefined}
            onPicked={onPicked}
            onJump={jumpTo}
          />
          {noteCount === 0 && <p className="composer-hint">Замечаний нет.</p>}
        </div>
      )}
    </div>
  );
}
