import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebase } from './rebase';

test('rebase: первое значение и нетронутое поле обновляются, несохранённая правка остаётся', () => {
  assert.equal(rebase(30, undefined, 45), 45);
  assert.equal(rebase(30, 30, 45), 45);
  assert.equal(rebase(50, 30, 45), 50);
  assert.deepEqual(rebase({ planner: 'a' }, { planner: 'a' }, { planner: 'b' }), { planner: 'b' });
  assert.deepEqual(rebase({ planner: 'моя' }, { planner: 'a' }, { planner: 'b' }), { planner: 'моя' });
});
