import { useEffect, useState } from 'react';
import type { RunFile, StageAttempt, StageId } from '@psflow/core';
import { STAGES } from '../lib/stages';
import { duration } from '../lib/format';

/** Гант прогона: строка на стадию, полоска на попытку; ожидание человека — штриховкой. */
export function Timeline({ run }: { run: RunFile }) {
  const live = run.status === 'running' || run.status === 'waiting';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const t0 = Date.parse(run.createdAt);
  const tEnd = run.finishedAt ? Date.parse(run.finishedAt) : live ? now : Date.parse(run.updatedAt);
  const span = Math.max(1000, tEnd - t0);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - t0) / span) * 100));

  // «limit» — вопрос человеку после попыток; рисуем в строке приёмки, это тоже решение человека.
  const rowOf = (s: StageId): StageId => (s === 'limit' ? 'gate2' : s);
  const rows = STAGES.map((st) => ({ st, attempts: run.attempts.filter((a) => rowOf(a.stage) === st.id) }));

  const tone = (a: StageAttempt, gate: boolean) => {
    if (gate) return a.status === 'running' ? 'wait-live' : 'wait';
    if (a.status === 'running') return 'live';
    if (a.status === 'failed') return 'fail';
    if (a.status === 'stopped') return 'stop';
    return 'done';
  };

  return (
    <div className="gantt" aria-label="Время по стадиям">
      {rows.map(({ st, attempts }) => (
        <div key={st.id} className="gantt-row">
          <span className="gantt-label">{st.title}</span>
          <span className="gantt-track">
            {attempts.map((a, i) => {
              const s = Date.parse(a.startedAt);
              const e = a.endedAt ? Date.parse(a.endedAt) : a.status === 'running' ? tEnd : s;
              const left = pct(s);
              const width = Math.max(0.8, pct(e) - left);
              const kind = tone(a, Boolean(st.gate));
              const tip = `${st.title}${attempts.length > 1 ? ` · попытка ${a.attempt}` : ''} — ${duration(a.startedAt, a.endedAt ?? new Date(tEnd).toISOString())}${a.summary ? `\n${a.summary}` : ''}`;
              return <i key={i} className={`gantt-bar g-${kind}`} style={{ left: `${left}%`, width: `${width}%` }} title={tip} />;
            })}
          </span>
        </div>
      ))}
      <div className="gantt-axis">
        <span>0</span>
        <span>{duration(new Date(t0).toISOString(), new Date(t0 + span / 2).toISOString())}</span>
        <span>{duration(run.createdAt, new Date(tEnd).toISOString())}</span>
      </div>
    </div>
  );
}
