import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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

async function running(pid: number): Promise<boolean> {
  const result = await run('ps', ['-o', 'stat=', '-p', String(pid)], { cwd: process.cwd(), env: process.env, timeoutMs: 2000 });
  assert.ok(!result.spawnError && !result.timedOut, 'ps вернул состояние процесса');
  const state = result.stdout.trim();
  // Процесс уже завершился, даже если системный родитель ещё не забрал его код выхода.
  return state !== '' && !state.startsWith('Z');
}

async function waitForExit(pid: number, message: string) {
  const deadline = performance.now() + 3000;
  while (await running(pid)) {
    assert.ok(performance.now() < deadline, message);
    await delay(25);
  }
}

for (const output of ['inherited', 'redirected'] as const) {
  test(`сервер в фоне завершается после выхода шелла (${output})`, { skip: process.platform === 'win32' }, async (t) => {
    const group = `g-server-${output}`;
    let recordPids!: (pids: number[]) => void;
    const started = new Promise<number[]>((resolve) => {
      recordPids = resolve;
    });
    let serverPid: number | undefined;
    t.after(async () => {
      await killGroup(group);
      if (serverPid && (await running(serverPid))) process.kill(serverPid, 'SIGKILL');
    });
    const redirect = output === 'redirected' ? ' >/dev/null 2>&1' : '';
    const p = run(`sleep 30${redirect} & echo "$$ $!"`, [], {
      cwd: process.cwd(),
      env: process.env,
      group,
      shell: true,
      waitForOutput: true,
      onStdoutLine: (line) => {
        const pids = line.split(' ').map(Number);
        serverPid = pids[1];
        recordPids(pids);
      },
    });

    const pids = await Promise.race([started, delay(2000, undefined, { ref: false })]);
    assert.ok(pids?.length === 2 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 1), 'шелл записал PID обоих процессов');
    const [shell, server] = pids;
    if (output === 'inherited') {
      await waitForExit(shell, 'шелл уже завершился');
      assert.equal(await running(server), true, 'сервер всё ещё работает');
      assert.equal(liveCount(group), 1);
      await killGroup(group);
      assert.equal((await p).killed, true);
    } else {
      assert.equal((await p).code, 0);
    }
    await waitForExit(server, 'сервер завершился');
    assert.equal(liveCount(group), 0);
  });
}

test('таймаут срабатывает и когда вывод держит фоновый потомок', { skip: process.platform === 'win32' }, async () => {
  const r = await run('sleep 30 & exit 0', [], { cwd: process.cwd(), env: process.env, shell: true, timeoutMs: 300, waitForOutput: true });
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
