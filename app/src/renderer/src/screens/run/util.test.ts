import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewItem, RunFile } from '@purpleflow/core';
import { toolNeeded } from '../../lib/tools';
import { currentStage, originSummary, stripAnsi, unstableText, withPicked } from './util';

const item = (p: Partial<ReviewItem>) => ({ file: null, line: null, message: 'м', ...p }) as ReviewItem;

test('currentStage: завершённый — на приёмке, лимит — в строке упавшей стадии', () => {
  assert.equal(currentStage({ status: 'finished', next: 'finish', attempts: [] } as unknown as RunFile), 'gate2');
  assert.equal(currentStage({ status: 'running', next: 'tests', attempts: [] } as unknown as RunFile), 'tests');
  const attempts = [
    { stage: 'implement', status: 'done' },
    { stage: 'tests', status: 'failed' },
  ];
  assert.equal(currentStage({ status: 'waiting', next: 'limit', attempts } as unknown as RunFile), 'tests');
});

test('unstableText: причина и не больше четырёх тестов', () => {
  assert.match(unstableText({ reason: 'retry', tests: [] }), /^Тесты упали, а при повторе прошли/);
  assert.match(unstableText({ reason: 'differs', tests: ['a'] }), /другие тесты \(a\)/);
  const many = unstableText({ reason: 'base', tests: ['1', '2', '3', '4', '5'] });
  assert.match(many, /исходном коде/);
  assert.match(many, /\(1; 2; 3; 4…\)/);
});

test('originSummary: только встречающиеся виды', () => {
  assert.equal(originSummary([item({})]), '');
  assert.equal(
    originSummary([item({ origin: 'unfixed' }), item({ origin: 'unfixed' }), item({ origin: 'new' })]),
    ' Из блокирующих: не исправлено с прошлого раза — 2, новых — 1.',
  );
});

test('withPicked: замечания дописываются к комментарию человека', () => {
  assert.equal(withPicked('свой', []), 'свой');
  const t = withPicked('  свой  ', [item({ file: 'a.ts', line: 3, message: 'x' }), item({ message: 'y' })]);
  assert.match(t, /^свой\n\nИсправь/);
  assert.match(t, /- a\.ts:3 — x\n- y$/);
  assert.match(withPicked(' ', [item({})]), /^Исправь/);
});

test('stripAnsi и toolNeeded', () => {
  assert.equal(stripAnsi('\x1b[38;2;1;2;3mтекст\x1b[39m\x1b[2K'), 'текст');
  assert.ok(toolNeeded('git', {}));
  assert.ok(toolNeeded('claude'));
  assert.ok(toolNeeded('codex', { planner: 'codex' }));
  assert.ok(!toolNeeded('codex', { planner: 'claude' }));
});
