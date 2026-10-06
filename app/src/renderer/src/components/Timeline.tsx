import { useEffect, useState } from 'react';
import type { RunFile, StageAttempt, StageId } from '@psflow/core';
import { STAGES } from '../lib/stages';
import { duration } from '../lib/format';
import { activeClock, ms } from '../lib/clock';

type BarKind = 'done' | 'live' | 'fail' | 'stop' | 'wait' | 'wait-live';

const LEGEND: { kind: BarKind; label: string }[] = [
  { kind: 'done', label: 'Работа агента или оркестратора' },
  { kind: 'live', label: 'Идёт сейчас' },
  { kind: 'fail', label: 'Неудачная попытка' },
  { kind: 'wait', label: 'Ожидание решения человека' },
];

/** Гант прогона: строка на стадию, полоска на попытку; ожидание человека — штриховкой. */
export function Timeline({ run, large = false }: { run: RunFile; large?: boolean }) {
  const live = run.status === 'running' || run.status === 'waiting';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  // Шкала — активное время: паузы, когда прогон стоял после ошибки или «Стоп», вырезаны.
  const clock = activeClock(run, now);
  const span = Math.max(1000, clock.total);
  const pct = (t: number) => Math.min(100, Math.max(0, (clock.map(t) / span) * 100));
  const tEnd = now;

  // «limit» — вопрос человеку после попыток; рисуем в строке приёмки, это тоже решение человека.
  const rowOf = (s: StageId): StageId => (s === 'limit' ? 'gate2' : s);
  const rows = STAGES.map((st) => ({ st, attempts: run.attempts.filter((a) => rowOf(a.stage) === st.id) }));

  const tone = (a: StageAttempt, gate: boolean): BarKind => {
    if (gate) return a.status === 'running' ? 'wait-live' : 'wait';
    if (a.status === 'running') return 'live';
    if (a.status === 'failed') return 'fail';
    if (a.status === 'stopped') return 'stop';
    return 'done';
  };

  const ticks = large ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];

  return (
    <div className={`gantt ${large ? 'is-large' : ''}`} aria-label="Время по стадиям">
      {large && (
        <div className="gantt-grid" aria-hidden>
          {ticks.map((f) => <i key={f} style={{ left: `${f * 100}%` }} />)}
        </div>
      )}
      {clock.gaps.length > 0 && (
        <div className="gantt-gaps">
          {clock.gaps.map((g, i) => (
            <i key={i} style={{ left: `${(g.at / span) * 100}%` }} title={`Прогон стоял ${ms(g.ms)} — после ошибки или остановки. Это время не учитывается.`} />
          ))}
        </div>
      )}
      {rows.map(({ st, attempts }) => (
        <div key={st.id} className="gantt-row">
          <span className="gantt-label" title={st.title}>{st.title}</span>
          <span className="gantt-track">
            {attempts.map((a, i) => {
              const s = Date.parse(a.startedAt);
              const e = a.endedAt ? Date.parse(a.endedAt) : a.status === 'running' ? tEnd : s;
              const left = pct(s);
              const width = Math.max(large ? 0.4 : 0.8, pct(e) - left);
              const kind = tone(a, Boolean(st.gate));
              const took = duration(a.startedAt, a.endedAt ?? new Date(tEnd).toISOString());
              const tip = `${st.title}${attempts.length > 1 ? ` · попытка ${a.attempt}` : ''} — ${took}${a.model ? ` · ${a.model}` : ''}${a.summary ? `\n${a.summary}` : ''}`;
              return (
                <i key={i} className={`gantt-bar g-${kind}`} style={{ left: `${left}%`, width: `${width}%` }} title={tip}>
                  {large && width > 7 && <b>{attempts.length > 1 ? `#${a.attempt} · ` : ''}{took}</b>}
                </i>
              );
            })}
          </span>
        </div>
      ))}
      <div className="gantt-axis">
        {ticks.map((f) => <span key={f}>{f === 0 ? '0' : ms(span * f)}</span>)}
      </div>
      {large && (
        <ul className="gantt-legend">
          {LEGEND.map((l) => <li key={l.kind}><i className={`gantt-bar g-${l.kind}`} />{l.label}</li>)}
          {clock.gaps.length > 0 && <li><i className="gantt-gap-sample" />Пауза после ошибки или остановки — вырезана, {ms(clock.paused)}</li>}
        </ul>
      )}
    </div>
  );
}

/** Вкладка «Таймлайн»: итог по времени и большой гант. */
export function TimelinePanel({ run }: { run: RunFile }) {
  const live = run.status === 'running' || run.status === 'waiting';
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const isGate = (s: StageId) => s === 'gate1' || s === 'gate2' || s === 'limit';
  const runs = run.attempts.filter((a) => !isGate(a.stage)).length;
  const humanMs = run.attempts
    .filter((a) => isGate(a.stage))
    .reduce((n, a) => n + ((a.endedAt ? Date.parse(a.endedAt) : Date.now()) - Date.parse(a.startedAt)), 0);
  const clock = activeClock(run);
  return (
    <div className="scroll">
      <div className="timeline-panel">
        <dl className="timeline-sum">
          <div><dt>Активное время</dt><dd>{ms(clock.total)}</dd></div>
          <div><dt>Ожидание человека</dt><dd>{ms(humanMs)}</dd></div>
          <div><dt>Запусков стадий</dt><dd>{runs}</dd></div>
          {clock.paused > 0 && <div><dt>Простой не учтён</dt><dd>{ms(clock.paused)}</dd></div>}
        </dl>
        <Timeline run={run} large />
      </div>
    </div>
  );
}
