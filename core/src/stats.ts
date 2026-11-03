// Статистика проекта по его прогонам: сколько принято с первого раза, где возвраты, сколько времени уходит.
import { isGate } from './stage-info.js';
import type { ProjectStats, RunFile, RunMode, StageId } from './types.js';

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function projectStats(runs: RunFile[], now = Date.now(), days = 28): ProjectStats {
  const finished = runs.filter((r) => r.status === 'finished');
  // Человек вернул план или результат — значит, с первого раза не вышло.
  const humanReturns = (r: RunFile) => r.gates.filter((g) => g.decision === 'reject' || g.decision === 'fix').length;

  let agentMs = 0;
  let waitMs = 0;
  for (const r of runs) {
    for (const a of r.attempts) {
      const ms = Math.max(
        0,
        (a.endedAt ? Date.parse(a.endedAt) : r.status === 'running' || r.status === 'waiting' ? now : Date.parse(r.updatedAt)) -
          Date.parse(a.startedAt),
      );
      if (isGate(a.stage)) waitMs += ms;
      else agentMs += ms;
    }
  }

  const modes = new Map<RunMode, { total: number; finished: number }>();
  for (const r of runs) {
    const m = r.mode;
    const x = modes.get(m) ?? { total: 0, finished: 0 };
    x.total++;
    if (r.status === 'finished') x.finished++;
    modes.set(m, x);
  }

  const daily = new Map<string, { started: number; finished: number }>();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // Через календарь, а не 24 часа: в день перевода часов сутки короче или длиннее.
  for (let i = days - 1; i >= 0; i--)
    daily.set(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime()), { started: 0, finished: 0 });
  for (const r of runs) {
    const s = daily.get(dayKey(Date.parse(r.createdAt)));
    if (s) s.started++;
    const f = r.finishedAt && daily.get(dayKey(Date.parse(r.finishedAt)));
    if (f && r.status === 'finished') f.finished++;
  }

  const stops = new Map<StageId, number>();
  for (const r of runs) if (r.status === 'stopped') stops.set(r.next, (stops.get(r.next) ?? 0) + 1);

  return {
    total: runs.length,
    finished: finished.length,
    active: runs.filter((r) => r.status === 'running' || r.status === 'waiting' || r.status === 'queued').length,
    stopped: runs.filter((r) => r.status === 'stopped').length,
    cancelled: runs.filter((r) => r.status === 'cancelled').length,
    firstPass: finished.filter((r) => humanReturns(r) === 0).length,
    medianLeadMs: median(finished.filter((r) => r.finishedAt).map((r) => Date.parse(r.finishedAt!) - Date.parse(r.createdAt))),
    agentMs,
    waitMs,
    avgImplAttempts: finished.length ? finished.reduce((n, r) => n + Math.max(1, r.implAttemptsUsed), 0) / finished.length : null,
    returns: {
      plan: runs.reduce((n, r) => n + r.gates.filter((g) => g.gate === 'gate1' && g.decision === 'reject').length, 0),
      acceptance: runs.reduce(
        (n, r) => n + r.gates.filter((g) => g.gate === 'gate2' && (g.decision === 'reject' || g.decision === 'fix')).length,
        0,
      ),
      tests: runs.reduce((n, r) => n + r.tests.filter((t) => !t.passed).length, 0),
      review: runs.reduce((n, r) => n + r.reviews.filter((x) => x.blocking.length > 0).length, 0),
      visual: runs.reduce((n, r) => n + (r.visuals ?? []).filter((v) => v.blocking.length > 0).length, 0),
    },
    byMode: [...modes.entries()].map(([mode, x]) => ({ mode, ...x })).sort((a, b) => b.total - a.total),
    daily: [...daily.entries()].map(([day, x]) => ({ day, ...x })),
    stops: [...stops.entries()].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count),
    tokens: runs.reduce((n, r) => n + r.totals.input + r.totals.output + r.totals.cacheRead + r.totals.cacheWrite, 0),
    merged: runs.filter((r) => r.merged).length,
    prs: runs.filter((r) => r.pr).length,
  };
}
