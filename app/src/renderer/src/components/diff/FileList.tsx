// Список файлов диффа: по пунктам плана, деревом или списком; свёрнутые папки — свои у каждого диффа.
import type { DiffFile } from '@purpleflow/core';
import { Check, ChevronRight, FileCode2, FileMinus2, FilePlus2, Folder, List, ListChecks, ListTree } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { treeOrder, type TreeDir } from './tree';

export type FilesView = 'plan' | 'tree' | 'list';
export type PlanGroup = { title: string; items: DiffFile[] };

export function FileList({
  files,
  sorted,
  tree,
  planGroups,
  view,
  onView: setView,
  current,
  onPick,
  countFor,
  isViewed,
  viewedCount,
}: {
  files: DiffFile[];
  sorted: DiffFile[];
  tree: TreeDir;
  planGroups: PlanGroup[];
  view: FilesView;
  onView: (v: FilesView) => void;
  current: string | null;
  onPick: (path: string) => void;
  countFor: (path: string) => number;
  isViewed: (path: string) => boolean;
  /** Сколько отмечено просмотренными; null — отметки выключены. */
  viewedCount: number | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const asTree = view === 'tree';

  const fileRow = (f: DiffFile, depth: number, withDir: boolean) => {
    const n = countFor(f.path);
    const name = f.path.split('/').pop();
    const dir = f.path.slice(0, f.path.length - (name?.length ?? 0));
    return (
      <li key={f.path}>
        <button
          className={`file ${f.path === current ? 'is-on' : ''} ${isViewed(f.path) ? 'is-viewed' : ''}`}
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => onPick(f.path)}
          title={f.path}
        >
          <span className={`file-st st-${f.status}`}>
            {f.status === 'A' ? <FilePlus2 size={14} /> : f.status === 'D' ? <FileMinus2 size={14} /> : <FileCode2 size={14} />}
          </span>
          <span className="file-name">
            <span>{name}</span>
            {withDir && dir && <small>{dir}</small>}
          </span>
          {n > 0 && <span className="file-n">{n}</span>}
          {isViewed(f.path) && <Check size={13} className="file-viewed" aria-label="Просмотрено" />}
        </button>
      </li>
    );
  };

  const toggleDir = (p: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const renderDir = (d: TreeDir, depth: number): ReactNode[] => {
    const inner = [
      ...d.dirs.flatMap((x) => {
        const shut = collapsed.has(x.path);
        const n = treeOrder(x).reduce((k, f) => k + countFor(f.path), 0);
        return [
          <li key={`d:${x.path}`}>
            <button
              className={`file dir ${shut ? 'is-shut' : ''}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => toggleDir(x.path)}
              title={x.path}
            >
              <ChevronRight size={13} className="dir-caret" />
              <Folder size={14} className="dir-icon" />
              <span className="file-name">
                <span>{x.name}</span>
              </span>
              {n > 0 ? <span className="file-n">{n}</span> : <span className="dir-count">{x.count}</span>}
            </button>
          </li>,
          ...(shut ? [] : renderDir(x, depth + 1)),
        ];
      }),
      ...d.files.map((f) => fileRow(f, depth, false)),
    ];
    return inner;
  };

  return (
    <aside className="diff-files">
      <div className="diff-files-head">
        <span>Файлы</span>
        <span className="muted">{viewedCount !== null ? `${viewedCount} из ${files.length}` : files.length}</span>
        <span className="grow" />
        <span className="diff-files-modes" role="radiogroup" aria-label="Вид списка файлов">
          {planGroups.length > 0 && (
            <button
              role="radio"
              aria-checked={view === 'plan'}
              className={`diff-files-mode ${view === 'plan' ? 'is-on' : ''}`}
              title="По пунктам плана"
              onClick={() => setView('plan')}
            >
              <ListChecks size={14} />
            </button>
          )}
          <button
            role="radio"
            aria-checked={view === 'tree'}
            className={`diff-files-mode ${view === 'tree' ? 'is-on' : ''}`}
            title="Деревом"
            onClick={() => setView('tree')}
          >
            <ListTree size={14} />
          </button>
          <button
            role="radio"
            aria-checked={view === 'list'}
            className={`diff-files-mode ${view === 'list' ? 'is-on' : ''}`}
            title="Списком"
            onClick={() => setView('list')}
          >
            <List size={14} />
          </button>
        </span>
      </div>
      <ul>
        {view === 'plan'
          ? planGroups.flatMap((g) => {
              const shut = collapsed.has(`plan:${g.title}`);
              const n = g.items.reduce((k, f) => k + countFor(f.path), 0);
              return [
                <li key={`g:${g.title}`}>
                  <button
                    className={`file dir plan-group ${shut ? 'is-shut' : ''} ${/^Без пункта|^Вне плана/.test(g.title) ? 'is-offplan' : ''}`}
                    onClick={() => toggleDir(`plan:${g.title}`)}
                    title={g.title}
                  >
                    <ChevronRight size={13} className="dir-caret" />
                    <span className="file-name">
                      <span>{g.title}</span>
                    </span>
                    {n > 0 ? <span className="file-n">{n}</span> : <span className="dir-count">{g.items.length}</span>}
                  </button>
                </li>,
                ...(shut ? [] : g.items.map((f) => fileRow(f, 1, true))),
              ];
            })
          : asTree
            ? renderDir(tree, 0)
            : sorted.map((f) => fileRow(f, 0, true))}
      </ul>
    </aside>
  );
}
