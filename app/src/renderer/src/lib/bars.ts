import type { RunFile, StageAttempt, StageId } from '@psflow/core';
import type { ActiveClock } from './clock';
import { duration } from './format';
import { limitRow, stageTitle } from './stages';

export type BarKind = 'done' | 'live' | 'fail' | 'stop' | 'wait' | 'wait-live';

export interface Bar {
  attempt: StageAttempt;
  /** Позиция и ширина на сжатой шкале активного времени, %. */
  left: number;
  width: number;
  kind: BarKind;
  took: string;
  tip: string;
}

const GATES: StageId[] = ['gate0', 'gate1', 'gate2', 'limit'];
export const isGate = (s: StageId) => GATES.includes(s);

/** Строка попытки: «limit» — в строке стадии, которая не пропустила дальше; ответы на вопросы — в уточнении. */
export const rowOf = (run: Pick<RunFile, 'attempts'>, a: StageAttempt): StageId =>
  a.stage === 'limit' ? limitRow(run, run.attempts.indexOf(a)) : a.stage === 'gate0' ? 'clarify' : a.stage;

/** Полоски попыток одной стадии на общей шкале прогона (паузы после ошибок вырезаны). */
export function stageBars(run: RunFile, clock: ActiveClock, stage: StageId, now: number, minWidth = 0.8): Bar[] {
  const span = Math.max(1000, clock.total);
  const pct = (t: number) => Math.min(100, Math.max(0, (clock.map(t) / span) * 100));
  const title = stageTitle(run, stage);
  const attempts = run.attempts.filter((a) => rowOf(run, a) === stage);
  return attempts.map((a) => {
    const s = Date.parse(a.startedAt);
    const e = a.endedAt ? Date.parse(a.endedAt) : a.status === 'running' ? now : s;
    const left = pct(s);
    const width = Math.max(minWidth, pct(e) - left);
    const kind: BarKind = isGate(a.stage)
      ? (a.status === 'running' ? 'wait-live' : 'wait')
      : a.status === 'running' ? 'live' : a.status === 'failed' ? 'fail' : a.status === 'stopped' ? 'stop' : 'done';
    const took = duration(a.startedAt, a.endedAt ?? new Date(now).toISOString());
    const tip = `${title}${attempts.length > 1 ? ` · попытка ${a.attempt}` : ''} — ${took}${a.model ? ` · ${a.model}` : ''}${a.summary ? `\n${a.summary}` : ''}`;
    return { attempt: a, left, width, kind, took, tip };
  });
}
