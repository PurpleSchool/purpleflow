import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killGroup, killPid, liveCount, parseEtime, run, setPidTracker } from './proc.js';

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

test('процесс вышел, фоновый потомок держит вывод: run не висит, пока жив потомок', { skip: process.platform === 'win32' }, async () => {
  const r = await run('sh', ['-c', 'echo hi; sleep 30 & exit 3'], { cwd: process.cwd(), env: process.env });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /hi/);
  assert.ok(r.durationMs < 10_000, `ждали ${r.durationMs} мс`);
});

test('сервер в фоне считается живым, пока держит вывод; «Стоп» завершает ожидание', { skip: process.platform === 'win32' }, async () => {
  let done = false;
  const p = run('sh', ['-c', 'sleep 30 & exit 0'], { cwd: process.cwd(), env: process.env, group: 'g-server', waitForOutput: true });
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done, false);
  await killGroup('g-server');
  const r = await p;
  assert.equal(r.killed, true);
  assert.equal(liveCount('g-server'), 0);
});

test('таймаут срабатывает и когда вывод держит фоновый потомок', { skip: process.platform === 'win32' }, async () => {
  const r = await run('sh', ['-c', 'sleep 30 & exit 0'], { cwd: process.cwd(), env: process.env, timeoutMs: 300, waitForOutput: true });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 5000, `ждали ${r.durationMs} мс`);
});

test('сбой учёта PID не оставляет процесс без присмотра', async (t) => {
  t.after(() => setPidTracker(null));
  setPidTracker({
    add: () => {
      throw new Error('диск полон');
    },
    remove: () => {},
  });
  const r = await run('sh', ['-c', 'exit 0'], { cwd: process.cwd(), env: process.env });
  assert.equal(r.code, 0);
});

test('parseEtime: все формы вывода ps', () => {
  assert.equal(parseEtime(' 00:05\n'), 5);
  assert.equal(parseEtime('02:03'), 123);
  assert.equal(parseEtime('01:00:01'), 3601);
  assert.equal(parseEtime('2-00:00:10'), 172810);
  assert.equal(parseEtime(''), null);
  assert.equal(parseEtime('ELAPSED'), null);
});

test('killPid: процесс, начавшийся после записи PID, чужой — его не трогаем', { skip: process.platform === 'win32' }, async () => {
  const p = run('sleep', ['30'], { cwd: process.cwd(), env: process.env, group: 'g-pid' });
  await new Promise((r) => setTimeout(r, 200));
  const out = await run('pgrep', ['-n', '-f', '^sleep 30$'], { cwd: process.cwd(), env: process.env });
  const pid = Number(out.stdout.trim());
  assert.ok(pid > 0);
  try {
    await killPid(pid, Date.now() - 3_600_000);
    assert.doesNotThrow(() => process.kill(pid, 0), 'PID записан час назад, процесс моложе — номер достался другому');
    await killPid(pid, Date.now());
    assert.equal((await p).code === 0, false, 'запись свежая — это наш процесс');
    await killPid(999_999);
  } finally {
    await killGroup('g-pid');
  }
});
