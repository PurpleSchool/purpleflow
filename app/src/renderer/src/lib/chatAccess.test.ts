import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessOf, accessPatch } from './chatAccess';

test('режим чата: три режима туда и обратно, полный доступ — только поверх правок', () => {
  for (const a of ['read', 'edits', 'full'] as const) assert.equal(accessOf(accessPatch(a)), a);
  assert.equal(accessOf({ edits: false, fullAccess: true }), 'read');
  assert.equal(accessOf({ edits: true }), 'edits');
});
