import { useEffect, useState } from 'react';
import type { RunFile, StageId } from '@psflow/core';
import { STAGES } from '../lib/stages';
import { activeClock, ms } from '../lib/clock';
import { isGate, stageBars, type BarKind } from '../lib/bars';

const LEGEND: { kind: BarKind; label: string }[] = [
  { kind: 'done', label: 'Работа агента или оркестратора' },
  { kind: 'live', label: 'Идёт сейчас' },
  { kind: 'fail', label: 'Неудачная попытка' },
  { kind: 'wait', label: 'Ожидание решения человека' },
];

/** Тикает раз в секунду, пока прогон жив, — чтобы текущие полоски росли. */
export function useNow(run: RunFile): number {
  const live = run.status === 'running' || run.status === 'waiting';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return live ? now : Date.now();
}

/** Большой гант: строка на стадию, полоска на попытку; ожидание человека — штриховкой. */
export function Timeline({ run, onSelect }: { run: RunFile; onSelect?: (s: StageId) => void }) {
  const now = useNow(run);
  const clock = activeClock(run, now);
  const span = Math.max(1000, clock.total);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="gantt is-large" aria-label="Время по стадиям">
      <div className="gantt-grid" aria-hidden>
        {ticks.map((f) => <i key={f} style={{ left: `${f * 100}%` }} />)}
      </div>
      {clock.gaps.length > 0 && (
        <div className="gantt-gaps">
          {clock.gaps.map((g, i) => (
            <i key={i} style={{ left: `${(g.at / span) * 100}%` }} title={`Прогон стоял ${ms(g.ms)} — после ошибки или остановки. Это время не учитывается.`} />
          ))}
        </div>
      )}
      {STAGES.map((st) => {
        const bars = stageBars(run, clock, st.id, now, 0.4);
        return (
          <div key={st.id} className="gantt-row">
            <button className="gantt-label" title={`Открыть «${st.title}»`} onClick={() => onSelect?.(st.id)} disabled={!bars.length}>
              {st.title}
            </button>
            <span className="gantt-track">
              {bars.map((b, i) => (
                <i key={i} className={`gantt-bar g-${b.kind}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} title={b.tip}>
                  {b.width > 7 && <b>{bars.length > 1 ? `#${b.attempt.attempt} · ` : ''}{b.took}</b>}
                </i>
              ))}
            </span>
          </div>
        );
      })}
      <div className="gantt-axis">
        {ticks.map((f) => <span key={f}>{f === 0 ? '0' : ms(span * f)}</span>)}
      </div>
      <ul className="gantt-legend">
        {LEGEND.map((l) => <li key={l.kind}><i className={`gantt-bar g-${l.kind}`} />{l.label}</li>)}
        {clock.gaps.length > 0 && <li><i className="gantt-gap-sample" />Пауза после ошибки или остановки — вырезана, {ms(clock.paused)}</li>}
      </ul>
    </div>
  );
}

/** Вкладка «Таймлайн»: итог по времени и большой гант. */
export function TimelinePanel({ run, onSelect }: { run: RunFile; onSelect: (s: StageId) => void }) {
  const now = useNow(run);
  const runs = run.attempts.filter((a) => !isGate(a.stage)).length;
  const humanMs = run.attempts
    .filter((a) => isGate(a.stage))
    .reduce((n, a) => n + ((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt)), 0);
  const clock = activeClock(run, now);
  return (
    <div className="scroll">
      <div className="timeline-panel">
        <dl className="timeline-sum">
          <div><dt>Активное время</dt><dd>{ms(clock.total)}</dd></div>
          <div><dt>Ожидание человека</dt><dd>{ms(humanMs)}</dd></div>
          <div><dt>Запусков стадий</dt><dd>{runs}</dd></div>
          {clock.paused > 0 && <div><dt>Простой не учтён</dt><dd>{ms(clock.paused)}</dd></div>}
        </dl>
        <Timeline run={run} onSelect={onSelect} />
      </div>
    </div>
  );
}
