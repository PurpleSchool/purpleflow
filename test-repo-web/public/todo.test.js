import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, toggle } from './todo.js';

test('addTodo', () => {
  assert.deepEqual(addTodo([], ' Купить хлеб '), [{ title: 'Купить хлеб', done: false }]);
  assert.deepEqual(addTodo([], '   '), []);
});

test('toggle', () => {
  assert.equal(toggle([{ title: 'a', done: false }], 0)[0].done, true);
});
