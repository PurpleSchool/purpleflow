import type { RunFile, StageId } from '@purpleflow/core';

/** Промежутки короче этого — обычные переходы между стадиями, их считаем. Длиннее — прогон стоял. */
const GAP_MS = 5000;

export const GATES: StageId[] = ['gate0', 'gate1', 'gate2', 'limit'];

export interface ActiveClock {
  /** Активное время прогона, мс: идут стадии или ждём решения человека. */
  total: number;
  /** Реальный момент → позиция на сжатой шкале, мс от начала. */
  map: (t: number) => number;
  /** Вырезанные паузы: где на сжатой шкале и сколько длились. */
  gaps: { at: number; ms: number }[];
  /** Сколько всего вырезано. */
  paused: number;
}

/**
 * Время прогона без пауз, когда он стоял после ошибки или «Стоп» и его не перезапускали
 * (и когда приложение было закрыто посреди стадии).
 */
export function activeClock(run: RunFile, now = Date.now(), opts: { compressGates?: boolean } = {}): ActiveClock {
  const spans = run.attempts
    .map((a) => {
      const s = Date.parse(a.startedAt);
      const e = a.endedAt ? Date.parse(a.endedAt) : a.status === 'running' ? now : s;
      return [s, Math.max(s, e)] as [number, number];
    })
    .sort((x, y) => x[0] - y[0]);

  const merged: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s - last[1] <= GAP_MS) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const map = (t: number) => {
    let acc = 0;
    for (const [s, e] of merged) {
      if (t <= s) break;
      acc += Math.min(t, e) - s;
      if (t <= e) break;
    }
    return acc;
  };

  const gaps: { at: number; ms: number }[] = [];
  for (let i = 1; i < merged.length; i++) gaps.push({ at: map(merged[i - 1][1]), ms: merged[i][0] - merged[i - 1][1] });
  const total = merged.reduce((n, [s, e]) => n + (e - s), 0);
  const paused = gaps.reduce((n, g) => n + g.ms, 0);
  if (!opts.compressGates) return { total, map, gaps, paused };

  // Ожидание человека на шкале — фиксированный слот: час на приёмке не должен сплющивать работу агентов.
  const gateSpans = run.attempts
    .filter((a) => GATES.includes(a.stage))
    .map(
      (a) =>
        [Date.parse(a.startedAt), a.endedAt ? Date.parse(a.endedAt) : a.status === 'running' ? now : Date.parse(a.startedAt)] as [
          number,
          number,
        ],
    )
    .filter(([s, e]) => e > s);
  const gateMs = gateSpans.reduce((n, [s, e]) => n + (map(e) - map(s)), 0);
  const slot = Math.max(2000, (total - gateMs) * 0.05);
  const squeeze = (t: number) => {
    let cut = 0;
    for (const [s, e] of gateSpans) {
      const len = map(e) - map(s);
      if (len <= slot) continue;
      const inside = Math.max(0, Math.min(map(t), map(e)) - map(s));
      cut += inside * (1 - slot / len);
    }
    return map(t) - cut;
  };
  const end = Math.max(now, ...merged.map(([, e]) => e));
  const sgaps = gaps.map((g, i) => ({ ...g, at: squeeze(merged[i][1]) }));
  return { total: squeeze(end), map: squeeze, gaps: sgaps, paused };
}

/** Длительность в мс → «4 мин 17 с». */
export function ms(n: number): string {
  const s = Math.max(0, Math.round(n / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Время работы агентов и проверок: стадии без гейтов, параллельные (проверки и ревью) — один раз. */
export function agentTime(run: RunFile, now = Date.now()): number {
  const spans = run.attempts
    .filter((a) => !GATES.includes(a.stage))
    .map((a) => {
      const s = Date.parse(a.startedAt);
      const e = a.endedAt ? Date.parse(a.endedAt) : a.status === 'running' ? now : s;
      return [s, Math.max(s, e)] as [number, number];
    })
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [s, e] of spans) {
    if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [s, e];
    }
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}
