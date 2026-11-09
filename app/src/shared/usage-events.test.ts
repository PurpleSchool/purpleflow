import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoreCommand, CoreEvent } from '@purpleflow/core';
import { UsageQueue, usageFromCommand, usageFromCoreEvent, type UsageEvent, type UsageSendResult } from './usage-events';

const event = (name: string): UsageEvent => ({ name, occurredAt: '2026-11-09T13:00:00.000Z' });

test('команды превращаются в события без текста задачи и комментариев', () => {
  const start = {
    type: 'run.start',
    input: { projectPath: '/secret', task: 'секрет', testCommand: 'npm test', mode: 'bug' },
  } as CoreCommand;
  assert.deepEqual(usageFromCommand(start), { name: 'run_started', props: { mode: 'bug' } });
  assert.deepEqual(usageFromCommand({ type: 'gate.reject', runId: 'r', comment: 'секрет' }), {
    name: 'gate_decided',
    props: { decision: 'reject' },
  });
  assert.deepEqual(usageFromCommand({ type: 'run.pr', runId: 'r', base: 'main' }), { name: 'pr_created' });
  assert.equal(usageFromCommand({ type: 'run.stop', runId: 'r' }), null);
});

test('события ядра сводятся к разрешённым полям', () => {
  const tests = {
    type: 'tests.result',
    runId: 'r',
    result: { passed: false, durationMs: 12.6, output: 'секрет', command: 'x' },
  } as unknown as CoreEvent;
  assert.deepEqual(usageFromCoreEvent(tests), { name: 'tests_finished', props: { passed: false, durationMs: 13 } });
  const review = { type: 'review.result', runId: 'r', result: { blocking: [{}], notes: [] } } as unknown as CoreEvent;
  assert.deepEqual(usageFromCoreEvent(review), { name: 'review_finished', props: { hasBlocking: true } });
  assert.deepEqual(usageFromCoreEvent({ type: 'stage.failed', runId: 'r', stage: 'plan', error: 'секрет' }), {
    name: 'stage_failed',
    props: { stage: 'plan' },
  });
  assert.equal(usageFromCoreEvent({ type: 'agent.output', runId: 'r', stage: 'plan', text: 'секрет' }), null);
  assert.equal(usageFromCoreEvent({ type: 'run.finished', runId: 'r', status: 'running' }), null);
});

test('очередь шлёт пачками по 50', async () => {
  const sizes: number[] = [];
  const q = new UsageQueue(async (batch) => (sizes.push(batch.length), 'sent'));
  for (let i = 0; i < 120; i += 1) q.push(event(`e${i}`));
  await q.flush();
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.equal(q.size, 0);
});

test('сбой сети оставляет события, отказ сервера их выбрасывает', async () => {
  let result: UsageSendResult = 'failed';
  const q = new UsageQueue(async () => result);
  q.push(event('a'));
  await q.flush();
  assert.equal(q.size, 1);
  result = 'rejected';
  await q.flush();
  assert.equal(q.size, 0);
});

test('одновременные отправки не дублируют события, переполнение вытесняет старые', async () => {
  let calls = 0;
  const q = new UsageQueue(async () => (calls++, 'sent'));
  q.push(event('a'));
  await Promise.all([q.flush(), q.flush()]);
  assert.equal(calls, 1);

  const stuck = new UsageQueue(async () => 'failed');
  for (let i = 0; i < 501; i += 1) stuck.push(event(`e${i}`));
  assert.equal(stuck.size, 500);
});
