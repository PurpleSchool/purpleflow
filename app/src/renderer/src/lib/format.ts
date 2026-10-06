import type { RunStatus, TokenUsage } from '@psflow/core';

export function tokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace('.', ',') + ' млн';
  if (n >= 1000) return Math.round(n / 1000) + ' тыс.';
  return String(n);
}

export function usageTotal(u?: TokenUsage): number {
  if (!u) return 0;
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

export function cost(u?: TokenUsage): string | null {
  if (!u || u.costUsd == null) return null;
  return '$' + u.costUsd.toFixed(u.costUsd < 1 ? 3 : 2);
}

export function duration(fromIso: string, toIso?: string): string {
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `сегодня, ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `вчера, ${time}`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + `, ${time}`;
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Идёт',
  waiting: 'Ждёт решения',
  stopped: 'Остановлен',
  cancelled: 'Отменён',
  finished: 'Готов',
};

export function shortPath(p: string): string {
  const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/);
  return home ? '~' + p.slice(home[0].length) : p;
}
