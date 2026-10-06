import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChangeId } from './ids.js';

test('транслитерирует и делает kebab-case', () => {
  const id = makeChangeId('Добавь функцию sum с тестом!');
  assert.match(id, /^dobav-funktsiyu-sum-s-testom-[0-9a-f]{4}$/);
});

test('пустой текст даёт task-xxxx', () => {
  assert.match(makeChangeId('!!!'), /^task-[0-9a-f]{4}$/);
});
