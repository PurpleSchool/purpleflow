import type { RunFile } from '@psflow/core';

/** Промежутки короче этого — обычные переходы между стадиями, их считаем. Длиннее — прогон стоял. */
const GAP_MS = 5000;

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
export function activeClock(run: RunFile, now = Date.now()): ActiveClock {
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
  return { total, map, gaps, paused: gaps.reduce((n, g) => n + g.ms, 0) };
}

/** Длительность в мс → «4 мин 17 с». */
export function ms(n: number): string {
  const s = Math.max(0, Math.round(n / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
