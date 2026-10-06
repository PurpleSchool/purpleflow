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
      <defs>
        <linearGradient id="mk" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b8a3ff" />
          <stop offset="1" stopColor="#6c4bf0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#1e1935" stroke="rgba(184,163,255,.25)" />
      <rect x="8" y="7" width="4" height="18" rx="2" fill="url(#mk)" />
      <rect x="20" y="7" width="4" height="18" rx="2" fill="url(#mk)" />
      <path d="M4 16h24" stroke="#78cbff" strokeWidth="2" strokeLinecap="round" strokeDasharray="2.5 3.5" />
    </svg>
  );
}
