import { History, Play, Plus, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolName } from '@psflow/core';
import { useStore, type View } from '../lib/store';
import { STAGES } from '../lib/stages';

const TOOLS: ToolName[] = ['git', 'claude', 'codex', 'openspec'];

export function Sidebar() {
  const { state, go } = useStore();
  const v = state.view.name;
  const last = state.runs.find((r) => r.id === state.lastRunId);
  const active = state.runs.filter((r) => r.status === 'running' || r.status === 'waiting');

  const item = (name: View['name'], label: string, icon: ReactNode, onClick: () => void, extra?: ReactNode, disabled?: boolean) => (
    <button className={`nav-item ${v === name ? 'is-on' : ''}`} onClick={onClick} disabled={disabled}>
      {icon}
      <span>{label}</span>
      {extra}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="brand drag">
        <Mark />
        <div className="brand-text">
          <strong>PS Flow</strong>
          <span>PurpleSchool</span>
        </div>
      </div>

      <nav className="nav">
        {item('new', 'Новая задача', <Plus size={17} />, () => go({ name: 'new' }))}
        {item(
          'run', 'Прогон', <Play size={16} />,
          () => last && go({ name: 'run', runId: last.id }),
          active.length > 0 && <span className={`nav-badge ${active.some((r) => r.status === 'waiting') ? 'is-wait' : ''}`}>{active.length}</span>,
          !last,
        )}
        {item('history', 'История', <History size={16} />, () => go({ name: 'history' }), state.runs.length > 0 && <span className="nav-count">{state.runs.length}</span>)}
        {item('settings', 'Настройки', <Settings2 size={16} />, () => go({ name: 'settings' }))}
      </nav>

      {last && (
        <button className="side-run" onClick={() => go({ name: 'run', runId: last.id })}>
          <span className="side-run-label">{last.status === 'waiting' ? 'Ждёт вашего решения' : last.status === 'running' ? 'Сейчас идёт' : 'Последний прогон'}</span>
          <span className="side-run-title">{last.title}</span>
          <span className="side-run-track" aria-hidden>
            {STAGES.map((s) => {
              const idx = STAGES.findIndex((x) => x.id === (last.next === 'limit' ? 'review' : last.next));
              const me = STAGES.findIndex((x) => x.id === s.id);
              const st = last.status === 'finished' || me < idx ? 'done' : me === idx ? last.status : 'idle';
              return <i key={s.id} className={`t-${st} ${s.gate ? 'is-gate' : ''}`} />;
            })}
          </span>
        </button>
      )}

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
    </aside>
  );
}

/** Знак: два створа шлюза и проходящий через них поток. */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9.5" fill="#1d1e23" stroke="rgba(255,255,255,.09)" />
      <rect x="9" y="8" width="3" height="16" rx="1.5" fill="#ececef" />
      <rect x="20" y="8" width="3" height="16" rx="1.5" fill="#ececef" />
      <path d="M5.5 16h2M14.5 16h3M24.5 16h2" stroke="#8a74ee" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
