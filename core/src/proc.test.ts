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

test('idleTimeoutMs: молчащий процесс останавливается, говорящий — нет', async () => {
  const quiet = await run('sh', ['-c', 'echo start; sleep 5'], { cwd: process.cwd(), env: process.env, idleTimeoutMs: 400 });
  assert.equal(quiet.idle, true);
  assert.equal(quiet.timedOut, true);
  assert.ok(quiet.durationMs < 3000);
  const chatty = await run('sh', ['-c', 'for i in 1 2 3 4 5; do echo $i; sleep 0.2; done'], {
    cwd: process.cwd(),
    env: process.env,
    idleTimeoutMs: 600,
  });
  assert.equal(chatty.idle, undefined);
  assert.equal(chatty.code, 0);
});
