import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectStats } from './stats.js';
import type { RunFile } from './types.js';

const T0 = Date.parse('2026-10-07T10:00:00');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

function run(p: Partial<RunFile>): RunFile {
  return {
    version: 1, id: 'x', changeId: 'c', title: 't', task: 't', projectPath: '/p', worktreePath: '/w', branch: 'b', baseCommit: 'h', testCommand: '',
    models: { planner: '', executor: '', reviewer: '' }, status: 'finished', next: 'finish', attempts: [], planRetries: 0, implAttemptsUsed: 1, implAttemptsLimit: 3,
    tests: [], reviews: [], gates: [], totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, createdAt: iso(0), updatedAt: iso(0), ...p,
  } as RunFile;
}

test('projectStats: первый раз, возвраты, время агентов и ожидания', () => {
  const s = projectStats([
    run({ finishedAt: iso(10), attempts: [
      { stage: 'implement', attempt: 1, startedAt: iso(0), endedAt: iso(6), status: 'done' },
      { stage: 'gate2', attempt: 1, startedAt: iso(6), endedAt: iso(10), status: 'done' },
    ] }),
    run({ mode: 'bug', finishedAt: iso(30), implAttemptsUsed: 3, gates: [{ gate: 'gate2', at: iso(20), decision: 'fix' }],
      tests: [{ at: iso(5), command: 't', passed: false, exitCode: 1, durationMs: 1, output: '' }],
      reviews: [{ at: iso(8), blocking: [{ file: null, line: null, message: 'x' }], notes: [] }] }),
    run({ status: 'stopped', next: 'tests' }),
  ], T0 + 60 * 60_000);
  assert.equal(s.total, 3);
  assert.equal(s.finished, 2);
  assert.equal(s.firstPass, 1);
  assert.equal(s.medianLeadMs, 20 * 60_000);
  assert.equal(s.agentMs, 6 * 60_000);
  assert.equal(s.waitMs, 4 * 60_000);
  assert.equal(s.avgImplAttempts, 2);
  assert.deepEqual(s.returns, { plan: 0, acceptance: 1, tests: 1, review: 1, visual: 0 });
  assert.deepEqual(s.stops, [{ stage: 'tests', count: 1 }]);
  assert.equal(s.byMode.find((m) => m.mode === 'bug')?.total, 1);
  assert.equal(s.daily.at(-1)?.started, 3);
});
