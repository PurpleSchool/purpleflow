import { Archive, Check, ClipboardCheck, FlaskConical, Hammer, Map as MapIcon, Pause, ScanEye, UserRoundCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RunFile, StageId } from '@psflow/core';
import { STAGES, attemptsOf, nodeState, type NodeState } from '../lib/stages';
import { activeClock } from '../lib/clock';
import { stageBars } from '../lib/bars';
import { useNow } from './Timeline';

/** У каждой стадии всегда своя иконка; статус — цветом узла и значком в углу. */
export const STAGE_ICON: Record<StageId, ReactNode> = {
  plan: <MapIcon size={16} />,
  gate1: <UserRoundCheck size={16} />,
  implement: <Hammer size={16} />,
  tests: <FlaskConical size={16} />,
  review: <ScanEye size={16} />,
  gate2: <ClipboardCheck size={16} />,
  limit: <UserRoundCheck size={16} />,
  finish: <Archive size={16} />,
};

const BADGE: Partial<Record<NodeState, ReactNode>> = {
  done: <Check size={9} strokeWidth={3} />,
  failed: <X size={9} strokeWidth={3} />,
  stopped: <Pause size={8} strokeWidth={3} />,
};

const STATE_WORD: Record<NodeState, string> = {
  idle: 'впереди',
  active: 'работает',
  waiting: 'ждёт вас',
  done: 'готово',
  failed: 'ошибка',
  stopped: 'остановлено',
  stale: 'будет повторено',
};

/**
 * Список стадий — единая навигация: статус, время на общей шкале (как строка ганта)
 * и выбор, что показать справа.
 */
export function StageRail({ run, selected, onSelect }: { run: RunFile; selected: StageId | null; onSelect: (s: StageId) => void }) {
  const now = useNow(run);
  const clock = activeClock(run, now);
  return (
    <ol className="rail" aria-label="Стадии прогона">
      {STAGES.map((s) => {
        const st = nodeState(run, s.id);
        const tries = attemptsOf(run, s.id);
        const bars = stageBars(run, clock, s.id, now, 1.2);
        const model = s.role ? run.models[s.role] : '';
        const reachable = tries.length > 0 || run.next === s.id;
        return (
          <li key={s.id} className={`station st-${st} ${s.gate ? 'is-gate' : ''} ${selected === s.id ? 'is-selected' : ''}`}>
            <button
              className="station-hit"
              onClick={() => onSelect(s.id)}
              disabled={!reachable}
              aria-current={selected === s.id ? 'true' : undefined}
              title={tries[tries.length - 1]?.summary ?? s.hint}
            >
              <span className={`station-node ${s.gate ? 'is-gate-node' : ''}`} aria-hidden>
                <span className="node-core">{STAGE_ICON[s.id]}</span>
                {BADGE[st] && <span className={`node-badge b-${st}`}>{BADGE[st]}</span>}
              </span>
              <span className="station-body">
                <span className="station-title">
                  <span>{s.title}</span>
                  {s.id === 'implement' && (
                    <span className="tries" title={`Попыток реализации: ${run.implAttemptsUsed} из ${run.implAttemptsLimit}`}>
                      {Array.from({ length: Math.max(run.implAttemptsLimit, run.implAttemptsUsed) }, (_, k) => (
                        <i key={k} className={k < run.implAttemptsUsed ? (k === run.implAttemptsUsed - 1 && st === 'active' ? 'is-now' : 'is-used') : ''} />
                      ))}
                    </span>
                  )}
                  {s.id !== 'implement' && !s.gate && tries.length > 1 && <span className="count">×{tries.length}</span>}
                </span>
                <span className="station-meta">
                  <span className={`state-word w-${st}`}>{STATE_WORD[st]}</span>
                  <span className="actor">{s.actor}{model ? ` · ${model}` : ''}</span>
                </span>
                <span className="station-track" aria-hidden>
                  {bars.map((b, i) => (
                    <i key={i} className={`gantt-bar g-${b.kind}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} title={b.tip} />
                  ))}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
