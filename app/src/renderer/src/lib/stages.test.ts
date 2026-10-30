import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunFile, StageAttempt } from '@purpleflow/core';
import { nodeState, runStages, stageTitle, stagesFor } from './stages';

const at = (stage: StageAttempt['stage'], status: StageAttempt['status']): StageAttempt =>
  ({ stage, status, attempt: 1, startedAt: '2026-10-30T10:00:00Z' }) as StageAttempt;

function run(p: Partial<RunFile>): RunFile {
  return { mode: 'task', visual: false, status: 'running', next: 'plan', attempts: [], ...p } as RunFile;
}

test('stagesFor: быстрый режим без плана, визуальная проверка — перед приёмкой', () => {
  assert.deepEqual(
    stagesFor('quick').map((s) => s.id),
    ['implement', 'tests', 'review', 'gate2', 'finish'],
  );
  const bug = stagesFor('bug', true).map((s) => s.id);
  assert.equal(bug.indexOf('visual'), bug.indexOf('gate2') - 1);
});

test('runStages: у старых прогонов без «Уточнения» строки уточнения нет', () => {
  const old = run({ attempts: [at('plan', 'done')] });
  assert.ok(!runStages(old).some((s) => s.id === 'clarify'));
  const fresh = run({ attempts: [at('clarify', 'done')] });
  assert.equal(runStages(fresh)[0].id, 'clarify');
});

test('runStages: фоновые исходные проверки добавляют строку в начало', () => {
  const r = run({ attempts: [at('clarify', 'running'), at('baseline', 'running')] });
  assert.equal(runStages(r)[0].id, 'baseline');
});

test('nodeState: ожидание на гейте, пройденные и ещё не начатые стадии', () => {
  const r = run({
    status: 'waiting',
    next: 'gate1',
    attempts: [at('clarify', 'done'), at('plan', 'done'), at('gate1', 'running')],
  });
  assert.equal(nodeState(r, 'gate1'), 'waiting');
  assert.equal(nodeState(r, 'plan'), 'done');
  assert.equal(nodeState(r, 'implement'), 'idle');
});

test('nodeState: у завершённого прогона всё пройдено', () => {
  assert.equal(nodeState(run({ status: 'finished', next: 'finish' }), 'review'), 'done');
});

test('stageTitle: незнакомая стадия режима берёт общее название', () => {
  assert.ok(stageTitle(run({ mode: 'quick' }), 'plan').length > 0);
});
