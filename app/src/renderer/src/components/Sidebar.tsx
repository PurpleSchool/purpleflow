import { useMemo } from 'react';
import { PanelLeftClose, PanelLeftOpen, Plus, Settings } from 'lucide-react';
import type { RunSummary, ToolName } from '@psflow/core';
import { useStore } from '../lib/store';
import { shortPath } from '../lib/format';
import { MODES } from '../lib/stages';

const TOOLS: ToolName[] = ['git', 'claude', 'codex', 'openspec'];

const STATUS_WORD: Record<RunSummary['status'], string> = {
  queued: 'в очереди', running: 'идёт', waiting: 'ждёт вас', stopped: 'остановлен', cancelled: 'отменён', finished: 'готово',
};

/** Прогоны по группам: сначала ждущие решения человека, остальные — по дням. */
function groupRuns(runs: RunSummary[]) {
  const waiting = runs.filter((r) => r.status === 'waiting');
  const rest = runs.filter((r) => r.status !== 'waiting');
  const day = (iso: string) => new Date(iso).toDateString();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const label = (iso: string) => {
    const d = new Date(iso);
    if (day(iso) === today.toDateString()) return 'Сегодня';
    if (day(iso) === yesterday.toDateString()) return 'Вчера';
    if (d > weekAgo) return 'На этой неделе';
    return 'Ранее';
  };
  const groups: { title: string; runs: RunSummary[] }[] = [];
  if (waiting.length) groups.push({ title: 'Ждут вас', runs: waiting });
  for (const r of rest) {
    const t = label(r.createdAt);
    const g = groups.find((x) => x.title === t);
    if (g) g.runs.push(r);
    else groups.push({ title: t, runs: [r] });
  }
  return groups;
}

const projectName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Левая панель: новая задача, прогоны по дням, настройки и инструменты. Сворачивается (⌘B). */
export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { state, go } = useStore();
  const v = state.view;
  const groups = useMemo(() => groupRuns(state.runs), [state.runs]);
  const waiting = state.runs.filter((r) => r.status === 'waiting').length;
  const toggleTitle = `${collapsed ? 'Показать' : 'Скрыть'} панель (${window.psflow.platform === 'darwin' ? '⌘' : 'Ctrl+'}B)`;

  if (collapsed) {
    return (
      <div className="side-mini drag">
        <button className="side-icon" title={toggleTitle} onClick={onToggle}>
          <PanelLeftOpen size={17} />
          {waiting > 0 && <span className="side-badge">{waiting}</span>}
        </button>
        <button className="side-icon" title="Новая задача" onClick={() => go({ name: 'new' })}><Plus size={17} /></button>
      </div>
    );
  }

  return (
    <aside className="side">
      <div className="side-top drag">
        <div className="side-brand">
          <Mark size={22} />
          <span>PurpleFlow</span>
        </div>
        <button className="side-icon" title={toggleTitle} onClick={onToggle}><PanelLeftClose size={17} /></button>
      </div>

      <button className={`side-new ${v.name === 'new' ? 'is-on' : ''}`} onClick={() => go({ name: 'new' })}>
        <Plus size={16} /> Новая задача
      </button>

      <nav className="side-list" aria-label="Прогоны">
        {groups.length === 0 && <p className="side-empty">Прогонов пока нет. Опишите задачу — здесь появится её прогон.</p>}
        {groups.map((g) => (
          <section key={g.title} className={`side-group ${g.title === 'Ждут вас' ? 'is-attention' : ''}`}>
            <h4>{g.title}</h4>
            {g.runs.map((r) => (
              <button
                key={r.id}
                className={`side-run st-${r.status} ${v.name === 'run' && v.runId === r.id ? 'is-on' : ''}`}
                disabled={r.missing}
                title={r.missing ? `run.json не найден: ${r.runJsonPath}` : `${r.title}\n${shortPath(r.projectPath)} · ${STATUS_WORD[r.status]}`}
                onClick={() => go({ name: 'run', runId: r.id })}
              >
                <span className="side-dot" aria-label={STATUS_WORD[r.status]} />
                <span className="side-run-text">
                  <span className="side-run-title">{r.title}</span>
                  <span className="side-run-sub">
                    <span className="side-run-project">{r.missing ? 'run.json не найден' : projectName(r.projectPath)}</span>
                    {!r.missing && <span className="side-run-mode">{MODES.find((m) => m.id === (r.mode ?? 'task'))?.title}</span>}
                  </span>
                </span>
              </button>
            ))}
          </section>
        ))}
      </nav>

      <div className="side-bottom">
        <button className={`side-link ${v.name === 'settings' ? 'is-on' : ''}`} onClick={() => go({ name: 'settings' })}>
          <Settings size={16} /> Настройки
        </button>
        <div className="side-tools" title="Найденные инструменты">
          {TOOLS.map((t) => {
            const info = state.tools?.[t];
            const ok = info?.path && !info.error;
            return (
              <span key={t} className={`tool-chip ${state.toolsLoading && !info ? 'is-loading' : ok ? 'is-ok' : 'is-bad'}`} title={info ? `${info.path ?? 'не найден'} ${info.version ?? ''}` : 'проверяем…'}>
                <i />
                {t}
              </span>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

/** Знак PurpleSchool (purpleschool.ru): две встречные скобки. */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="-2 12.5 40 36" aria-hidden>
      <path d="M17.4634 38.706C17.3794 38.706 17.2674 38.678 17.1274 38.622C17.0154 38.566 16.8894 38.51 16.7494 38.454L1.62937 28.164C1.23737 27.884 0.929367 27.618 0.705367 27.366C0.509367 27.086 0.411367 26.736 0.411367 26.316V25.014C0.411367 24.594 0.509367 24.258 0.705367 24.006C0.929367 23.754 1.23737 23.488 1.62937 23.208L16.7494 12.918C16.8894 12.834 17.0154 12.764 17.1274 12.708C17.2674 12.652 17.3794 12.624 17.4634 12.624C17.7154 12.624 17.9254 12.708 18.0934 12.876C18.2614 13.044 18.3454 13.254 18.3454 13.506V18C18.3454 18.448 18.2194 18.798 17.9674 19.05C17.7154 19.274 17.4494 19.484 17.1694 19.68L8.01337 25.686L17.1694 31.734C17.4494 31.902 17.7154 32.098 17.9674 32.322C18.2194 32.546 18.3454 32.882 18.3454 33.33V37.866C18.3454 38.118 18.2614 38.328 18.0934 38.496C17.9254 38.636 17.7154 38.706 17.4634 38.706Z" fill="#E47AD5" />
      <path d="M18.5366 22.294C18.6206 22.294 18.7326 22.322 18.8726 22.378C18.9846 22.434 19.1106 22.49 19.2506 22.546L34.3706 32.836C34.7626 33.116 35.0706 33.382 35.2946 33.634C35.4906 33.914 35.5886 34.264 35.5886 34.684L35.5886 35.986C35.5886 36.406 35.4906 36.742 35.2946 36.994C35.0706 37.246 34.7626 37.512 34.3706 37.792L19.2506 48.082C19.1106 48.166 18.9846 48.236 18.8726 48.292C18.7326 48.348 18.6206 48.376 18.5366 48.376C18.2846 48.376 18.0746 48.292 17.9066 48.124C17.7386 47.956 17.6546 47.746 17.6546 47.494L17.6546 43C17.6546 42.552 17.7806 42.202 18.0326 41.95C18.2846 41.726 18.5506 41.516 18.8306 41.32L27.9866 35.314L18.8306 29.266C18.5506 29.098 18.2846 28.902 18.0326 28.678C17.7806 28.454 17.6546 28.118 17.6546 27.67L17.6546 23.134C17.6546 22.882 17.7386 22.672 17.9066 22.504C18.0746 22.364 18.2846 22.294 18.5366 22.294Z" fill="#6C38CC" />
    </svg>
  );
}
