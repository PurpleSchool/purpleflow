import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRunBranch, makeChangeId, runBranch } from './ids.js';

test('транслитерирует и делает kebab-case', () => {
  const id = makeChangeId('Добавь функцию sum с тестом!');
  assert.match(id, /^dobav-funktsiyu-sum-s-testom-[0-9a-f]{4}$/);
});

test('пустой текст даёт task-xxxx', () => {
  assert.match(makeChangeId('!!!'), /^task-[0-9a-f]{4}$/);
});

test('isRunBranch: свои ветки — purpleflow/ и старые psflow/, локальные и origin', () => {
  assert.ok(isRunBranch('purpleflow/add-x-1a2b'));
  assert.ok(isRunBranch('origin/psflow/add-x-1a2b'));
  assert.ok(!isRunBranch('main'));
  assert.ok(!isRunBranch('feature/purpleflow'));
  assert.equal(runBranch('add-x-1a2b'), 'purpleflow/add-x-1a2b');
});
