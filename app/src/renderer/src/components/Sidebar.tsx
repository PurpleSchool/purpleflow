import type { ToolName } from '@psflow/core';
import { useStore, type View } from '../lib/store';
import { PillTabs } from './PillTabs';

const TOOLS: ToolName[] = ['git', 'claude', 'codex', 'openspec'];

/** Верхняя панель: знак, навигация пилюлями, состояние инструментов. Тянется за окно (drag). */
export function AppBar() {
  const { state, go } = useStore();
  const v = state.view.name;
  const last = state.runs.find((r) => r.id === state.lastRunId);
  const active = state.runs.find((r) => r.status === 'running' || r.status === 'waiting');
  const current = active ?? last;

  const liveDot = current && (current.status === 'running' || current.status === 'waiting') ? <i className={`navdot ${current.status}`} /> : null;
  const go2 = (name: View['name']) => {
    if (name === 'run') {
      if (current) go({ name: 'run', runId: current.id });
    } else go({ name } as View);
  };

  return (
    <header className="appbar drag">
      <div className="appbar-brand">
        <Mark size={26} />
        <span>PS Flow</span>
      </div>

      <nav aria-label="Разделы">
        <PillTabs<View['name']>
          className="navpills"
          itemClassName="navpill"
          role="navigation"
          value={v}
          onChange={go2}
          items={[
            { id: 'new', label: 'Новая задача' },
            { id: 'run', label: <>{liveDot}Прогон</>, disabled: !current },
            { id: 'history', label: 'История' },
            { id: 'settings', label: 'Настройки' },
          ]}
        />
      </nav>

      <span className="grow" />

      <div className="appbar-tools" title="Найденные инструменты">
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
    </header>
  );
}

/** Знак: два створа шлюза и проходящий через них поток. */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9.5" fill="#1b1c1f" stroke="rgba(255,255,255,.08)" />
      <rect x="9" y="8" width="3" height="16" rx="1.5" fill="#e8e8ea" />
      <rect x="20" y="8" width="3" height="16" rx="1.5" fill="#e8e8ea" />
      <path d="M5.5 16h2M14.5 16h3M24.5 16h2" stroke="#8a74ee" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
