import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killGroup, liveCount, run } from './proc.js';

test('killGroup убивает всё дерево процессов', { skip: process.platform === 'win32' }, async () => {
  // Шелл с вложенным долгоживущим процессом.
  const p = run('sh -c "sleep 30 & sleep 30; wait"', [], { cwd: process.cwd(), env: process.env, shell: true, group: 'g1' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(liveCount('g1'), 1);
  await killGroup('g1');
  const r = await p;
  assert.equal(r.killed, true);
  assert.equal(liveCount('g1'), 0);
});
