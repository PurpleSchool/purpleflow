import { Archive, Bot, Check, FlaskConical, Hammer, Map as MapIcon, Pause, ScanEye, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { RunFile, StageId } from '@psflow/core';
import { STAGES, attemptsOf, lastAttempt, nodeState, type NodeState } from '../lib/stages';
import { duration, tokens, usageTotal } from '../lib/format';

const ICON: Partial<Record<StageId, ReactNode>> = {
  plan: <MapIcon size={16} />,
  implement: <Hammer size={16} />,
  tests: <FlaskConical size={16} />,
  review: <ScanEye size={16} />,
  finish: <Archive size={16} />,
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

export function StageRail({ run, selected, onSelect }: { run: RunFile; selected: StageId | null; onSelect: (s: StageId) => void }) {
  return (
    <ol className="rail" aria-label="Стадии прогона">
      {STAGES.map((s, i) => {
        const st = nodeState(run, s.id);
        const a = lastAttempt(run, s.id);
        const tries = attemptsOf(run, s.id).filter((x) => !s.gate);
        const nextSt = i < STAGES.length - 1 ? nodeState(run, STAGES[i + 1].id) : 'idle';
        const flowing = st === 'done' && nextSt !== 'idle' && nextSt !== 'stale';
        const model = s.role ? run.models[s.role] : '';
        return (
          <li
            key={s.id}
            className={`station st-${st} ${s.gate ? 'is-gate' : ''} ${selected === s.id ? 'is-selected' : ''} ${flowing ? 'is-flowing' : ''}`}
          >
            <button className="station-hit" onClick={() => onSelect(s.id)} aria-current={run.next === s.id ? 'step' : undefined}>
              <span className="station-node" aria-hidden>
                {s.gate ? <Lock open={st === 'done'} state={st} /> : (
                  <span className="node-core">
                    {st === 'done' ? <Check size={15} strokeWidth={2.6} /> : st === 'failed' ? <X size={15} strokeWidth={2.6} /> : st === 'stopped' ? <Pause size={14} /> : ICON[s.id] ?? <Bot size={16} />}
                  </span>
                )}
              </span>
              <span className="station-body">
                <span className="station-title">
                  {s.title}
                  {s.id === 'implement' && (
                    <span className="tries" title={`Попыток реализации: ${run.implAttemptsUsed} из ${run.implAttemptsLimit}`}>
                      {Array.from({ length: Math.max(run.implAttemptsLimit, run.implAttemptsUsed) }, (_, k) => (
                        <i key={k} className={k < run.implAttemptsUsed ? (k === run.implAttemptsUsed - 1 && st === 'active' ? 'is-now' : 'is-used') : ''} />
                      ))}
                    </span>
                  )}
                  {s.id === 'plan' && tries.length > 1 && <span className="count">×{tries.length}</span>}
                  {(s.id === 'tests' || s.id === 'review') && tries.length > 1 && <span className="count">×{tries.length}</span>}
                </span>
                <span className="station-meta">
                  <span className={`state-word w-${st}`}>{STATE_WORD[st]}</span>
                  <span className="actor">{s.actor}{model ? ` · ${model}` : ''}</span>
                </span>
                {a?.summary && st !== 'idle' && <span className="station-summary">{a.summary}</span>}
                {a && !s.gate && st !== 'idle' && (
                  <span className="station-stats">
                    {a.endedAt ? duration(a.startedAt, a.endedAt) : st === 'active' ? <Elapsed from={a.startedAt} /> : null}
                    {a.tokens && usageTotal(a.tokens) > 0 && <span>{tokens(usageTotal(a.tokens))} ток.</span>}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Ворота шлюза: две створки, которые расходятся, когда человек принял решение. */
function Lock({ open, state }: { open: boolean; state: NodeState }) {
  return (
    <span className={`lock ${open ? 'is-open' : ''} lock-${state}`}>
      <i className="leaf leaf-l" />
      <i className="leaf leaf-r" />
    </span>
  );
}

function Elapsed({ from }: { from: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{duration(from)}</span>;
}
