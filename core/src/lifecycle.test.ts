// Жизненный цикл прогона: завершение, восстановление после перезапуска, очередь, остановка, удаление и решения на гейтах.
// git настоящий, агенты и openspec подменены: стадии до и после проверяемой не нужны.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage, type AgentResult, type AgentRunOptions } from './agents/common.js';
import { decide } from './gates.js';
import { Orchestrator } from './orchestrator.js';
import { copyEnvFiles, cloneDeps } from './services/workspace.js';
import { stageFinish } from './stages/finish.js';
import { stageImplement } from './stages/implement.js';
import { stageReview } from './stages/review.js';
import type { CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const unix = { skip: process.platform === 'win32', timeout: 60_000 };
const okReply = (text = '{}'): AgentResult => ({ ok: true, text, usage: emptyUsage() });
type Claude = (o: AgentRunOptions) => Promise<AgentResult> | AgentResult;

function setup(t: { after: (fn: () => void) => void }, claude: Claude = () => okReply(), maxParallel = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-life-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const at =
    (cwd: string) =>
    (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' })
        .toString()
        .trim();
  const g = at(repo);
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  const calls = path.join(root, 'openspec-calls');
  fs.writeFileSync(
    path.join(bin, 'openspec'),
    `#!/bin/sh\n[ "$1" = "--version" ] && echo 1.0.0 && exit 0\necho "$*" >> "${calls}"\n[ "$1" = "init" ] && sleep "\${INIT_SLEEP:-0}" && mkdir -p openspec/changes\nexit 0\n`,
    { mode: 0o755 },
  );
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude'), openspec: path.join(bin, 'openspec') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 1,
    testTimeoutMin: 1,
    maxParallel,
  } as unknown as CoreSettings;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const core = new Orchestrator({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env,
    getSettings: () => settings,
    runners: { claude: (async (o: AgentRunOptions) => claude(o)) as never },
  });
  const k = core.kernel;
  const head = g('rev-parse', 'HEAD');
  const save = (over: Partial<RunFile> = {}) => {
    const run = {
      id: `run-${Math.random().toString(36).slice(2, 10)}`,
      title: 'Задача',
      task: 'Сделай',
      changeId: 'c',
      mode: 'quick',
      status: 'running',
      next: 'implement',
      workspace: 'worktree',
      visual: false,
      projectPath: repo,
      worktreePath: repo,
      branch: 'main',
      baseCommit: head,
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      models: {},
      attempts: [],
      tests: [],
      reviews: [],
      gates: [],
      implAttemptsUsed: 1,
      implAttemptsLimit: 3,
      totals: emptyUsage(),
      createdAt: '2026-01-01T00:00:00Z',
      ...over,
    } as unknown as RunFile;
    k.store.save(run);
    return run;
  };
  const until = async (id: string, ok: (r: RunFile) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const r = k.store.load(id);
      if (r && ok(r)) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(
      `не дождались: ${JSON.stringify({ s: k.store.load(id)?.status, n: k.store.load(id)?.next, m: k.store.load(id)?.message })}`,
    );
  };
  return {
    core,
    k,
    repo,
    root,
    g,
    at,
    head,
    save,
    until,
    env,
    settings,
    openspecCalls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''),
  };
}

const start = (core: Orchestrator, repo: string, over: object = {}) =>
  core.dispatch({ type: 'run.start', input: { projectPath: repo, task: 'Задача', testCommand: 'true', mode: 'quick', ...over } as never });

// ——— Завершение ———

test('финиш: коммит не прошёл — прогон не завершён, повтор доводит его до конца', unix, async (t) => {
  const { k, repo, g, save } = setup(t);
  const run = save({ next: 'finish' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'правка\n');
  const lock = path.join(repo, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  await assert.rejects(stageFinish(k, run));
  assert.equal(run.status, 'running');
  assert.equal(run.finishedAt, undefined);
  assert.equal(run.commit, undefined);
  assert.equal(run.attempts.at(-1)!.status, 'running');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'правка\n', 'работа агента цела');

  fs.rmSync(lock);
  await stageFinish(k, run);
  assert.equal(run.status, 'finished');
  assert.equal(run.commit, g('rev-parse', 'HEAD'));
  assert.match(g('log', '-1', '--format=%B'), /PurpleFlow run: /);
});

test('финиш: изменений нет — честно сказано; run.json быстрой правки не в коммите', unix, async (t) => {
  const { k, repo, g, save, head } = setup(t);
  const empty = save({ next: 'finish', changeId: 'x', workspace: 'worktree' });
  // run.json быстрой правки лежит в рабочей копии — он не считается изменением.
  await stageFinish(k, empty);
  assert.equal(empty.commit, head);
  assert.match(k.store.readLog(empty.id), /изменений нет/);

  const run = save({ next: 'finish', changeId: 'x' });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  await stageFinish(k, run);
  const files = g('show', '--name-only', '--format=', run.commit!).split('\n');
  assert.deepEqual(files, ['b.txt']);
});

test('финиш в режиме «ветка»: подсказка, как вернуться', unix, async (t) => {
  const { k, repo, save } = setup(t);
  const run = save({ next: 'finish', workspace: 'branch', originalBranch: 'dev' });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  await stageFinish(k, run);
  assert.match(k.store.readLog(run.id), /Вернуться: git checkout dev/);
});

test('финиш с архивом: повтор после сбоя не архивирует второй раз', unix, async (t) => {
  const { k, repo, save, openspecCalls } = setup(t);
  const dir = path.join(repo, 'openspec', 'changes', 'archive', 'c');
  fs.mkdirSync(dir, { recursive: true });
  const run = save({ next: 'finish', mode: 'task', archivedPath: path.join(dir, 'run.json') });
  await stageFinish(k, run);
  assert.doesNotMatch(openspecCalls(), /archive/);
  assert.equal(run.status, 'finished');
});

test('финиш круга по PR: сообщение со списком замечаний, push в ветку PR', unix, async (t) => {
  const { k, repo, root, g, at, save, head } = setup(t);
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(remote);
  at(remote)('init', '-q', '--bare', '-b', 'main');
  g('remote', 'add', 'origin', remote);
  const pr = { url: 'u', number: 5, base: 'main', createdAt: '' };
  const item = (o: object) => ({ id: '1', author: 'a', body: 'x', ...o });
  const run = save({
    next: 'finish',
    pr,
    prRound: 2,
    roundBase: head,
    prRounds: [
      {
        round: 2,
        at: '',
        note: 'заметка человека',
        items: [item({ kind: 'check', body: 'lint' }), item({ kind: 'thread', path: 'a.txt', body: 'Поправь\nвторая строка' })],
      },
    ] as never,
  });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'правка\n');
  await stageFinish(k, run);
  const msg = g('log', '-1', '--format=%B');
  assert.match(msg, /замечания PR #5/);
  assert.match(msg, /CI: lint/);
  assert.match(msg, /a\.txt: Поправь\n/);
  assert.match(msg, /заметка человека/);
  assert.equal(run.prRounds!.at(-1)!.commit, run.commit);
  assert.equal(at(remote)('rev-parse', 'main'), run.commit, 'правки ушли в ветку PR');
});

test('финиш обновления ветки: push не прошёл — коммит есть, прогон завершён, причина видна', unix, async (t) => {
  const { k, repo, g, save, head } = setup(t);
  const run = save({
    next: 'finish',
    pr: { url: 'u', number: 5, base: 'main', createdAt: '' },
    prRound: 2,
    roundBase: head,
    prRounds: [{ round: 2, at: '', items: [], kind: 'update', conflicts: ['a.txt'] }] as never,
  });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'слито\n');
  await stageFinish(k, run);
  assert.match(g('log', '-1', '--format=%B'), /^Merge main в main\n\nРазрешены конфликты:\n- a\.txt/);
  assert.equal(run.status, 'finished');
  assert.ok(run.commit);
  assert.match(run.message ?? '', /Коммит есть, но push не прошёл/);
  assert.equal(run.prRounds!.at(-1)!.commit, undefined);
});

// ——— Восстановление ———

test('восстановление: оборванная стадия в очередь, попытка возвращена, исполнитель предупреждён', unix, async (t) => {
  const { core, k, save } = setup(t);
  const running = save({
    next: 'implement',
    implAttemptsUsed: 2,
    executorSession: 's',
    attempts: [{ stage: 'implement', attempt: 2, startedAt: '', status: 'running' }],
  });
  const tests = save({ next: 'tests', implAttemptsUsed: 2 });
  const waiting = save({ status: 'waiting', next: 'gate2' });
  const finished = save({ status: 'finished', next: 'finish' });
  k.pumping = true; // Смотрим состояние до запуска из очереди.
  await core.recover();
  const r = k.mustLoad(running.id);
  assert.equal(r.status, 'queued');
  assert.equal(r.attempts[0].status, 'stopped');
  assert.ok(r.attempts[0].endedAt);
  assert.equal(r.implAttemptsUsed, 1);
  assert.match(r.feedback!.text, /оборвалась на середине/);
  assert.match(r.message!, /продолжится сам/);
  assert.equal(k.mustLoad(tests.id).implAttemptsUsed, 2, 'попытку возвращает только реализация');
  assert.equal(k.mustLoad(waiting.id).status, 'waiting');
  assert.equal(k.mustLoad(finished.id).status, 'finished');
});

test(
  'восстановление: оборванная проба исходного кода возвращает изменения из stash; не вернулись — прогон стоит с подсказкой',
  unix,
  async (t) => {
    const { core, k, repo, g, save } = setup(t);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'работа агента\n');
    g('stash', 'push', '-m', 'проба');
    const sha = g('rev-parse', 'stash@{0}');
    const run = save({ baseProbeStash: sha });
    const lost = save({ baseProbeStash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    k.pumping = true;
    await core.recover();
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'работа агента\n');
    assert.equal(k.mustLoad(run.id).baseProbeStash, undefined);
    assert.equal(k.mustLoad(run.id).status, 'queued');
    const l = k.mustLoad(lost.id);
    assert.equal(l.status, 'stopped');
    assert.match(l.message!, /git stash apply deadbeef/);
  },
);

test('восстановление: процессы, пережившие падение приложения, завершаются', unix, async (t) => {
  const { core, k, save } = setup(t);
  const run = save({ status: 'stopped' });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  t.after(() => child.kill('SIGKILL'));
  k.store.writePids(`${run.id}:server`, [child.pid!]);
  k.pumping = true;
  await core.recover();
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.deepEqual(k.store.readPids(`${run.id}:server`), []);
});

test('восстановление: прогон продолжается сам с прерванной стадии', unix, async (t) => {
  const { core, k, repo, save, until } = setup(t, (o) => {
    fs.writeFileSync(path.join(o.cwd, 'done.txt'), 'x\n');
    return okReply('Готово');
  });
  const run = save({ next: 'implement', testCommand: 'true', quickFix: true });
  await core.recover();
  const r = await until(run.id, (x) => x.status !== 'running' && x.status !== 'queued');
  assert.deepEqual([r.status, r.next, r.message], ['waiting', 'gate2', r.message]);
  assert.ok(fs.existsSync(path.join(repo, 'done.txt')));
  assert.equal(k.driving.has(run.id), false);
});

// ——— Очередь, остановка, удаление ———

test('очередь: лимит соблюдается, снятие и запуск вручную, место освободилось — следующий', unix, async (t) => {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  const claude: Claude = async (o) => {
    seen.push(o.cwd);
    if (seen.length === 1) await gate;
    return okReply('Готово');
  };
  const { core, k, repo, until } = setup(t, claude, 1);
  const a = (await start(core, repo)).runId!;
  await until(a, () => seen.length === 1);
  const b = (await start(core, repo, { task: 'Вторая' })).runId!;
  const c = (await start(core, repo, { task: 'Третья' })).runId!;
  assert.equal(k.mustLoad(b).status, 'queued');
  assert.ok(k.mustLoad(b).workspacePending, 'копия создаётся только при запуске');
  assert.ok(!fs.existsSync(k.mustLoad(b).worktreePath));

  await core.dispatch({ type: 'run.stop', runId: b });
  assert.equal(k.mustLoad(b).status, 'stopped');
  assert.match(k.mustLoad(b).message!, /Снят с очереди/);

  // «Продолжить» запускает снятый без оглядки на лимит.
  await core.dispatch({ type: 'run.resume', runId: b });
  await until(b, (r) => !r.workspacePending);
  assert.ok(fs.existsSync(k.mustLoad(b).worktreePath));
  assert.equal(k.mustLoad(c).status, 'queued');

  release();
  const free = (r: RunFile) => r.status !== 'running' && r.status !== 'queued';
  for (const id of [a, b, c]) await until(id, free);
  assert.ok(fs.existsSync(k.mustLoad(c).worktreePath), 'третий запущен, когда освободилось место');
  assert.equal(k.driving.size, 0);
});

test('запуск из очереди: проект на другой ветке — прогон стоит с причиной; «Продолжить» её повторяет', unix, async (t) => {
  const { core, k, g, save, until } = setup(t);
  g('branch', 'purpleflow/x');
  const run = save({ status: 'queued', workspace: 'branch', branch: 'purpleflow/x', next: 'implement' });
  await core.settingsChanged();
  const r = await until(run.id, (x) => x.status === 'stopped');
  assert.match(r.message!, /Не удалось начать прогон: Проект сейчас на ветке main/);
  await assert.rejects(core.dispatch({ type: 'run.resume', runId: run.id }), /Переключитесь на purpleflow\/x/);
  assert.equal(k.mustLoad(run.id).status, 'stopped');
});

test('«Стоп» во время подготовки копии: прогон останавливается, копия остаётся', unix, async (t) => {
  const { core, k, repo, env } = setup(t);
  env.INIT_SLEEP = '1';
  const p = start(core, repo, { mode: 'task', workspace: 'worktree' });
  for (let i = 0; i < 100 && !k.preparing.size; i++) await new Promise((r) => setTimeout(r, 20));
  const [id] = k.preparing;
  assert.ok(id);
  await core.dispatch({ type: 'run.stop', runId: id });
  await p;
  const r = k.mustLoad(id);
  assert.equal(r.status, 'stopped');
  assert.equal(r.workspacePending, undefined);
  assert.ok(fs.existsSync(r.worktreePath));
  assert.equal(k.driving.has(id), false);
});

test('старт: понятные отказы до создания чего-либо', unix, async (t) => {
  const { core, root, repo, g } = setup(t);
  const emptyRepo = path.join(root, 'empty');
  fs.mkdirSync(emptyRepo);
  execFileSync('git', ['init', '-q'], { cwd: emptyRepo });
  await assert.rejects(start(core, emptyRepo), /нет ни одного коммита/);
  await assert.rejects(start(core, root), /не являет/);
  await assert.rejects(start(core, repo, { task: '  ' }), /Опишите задачу/);
  await assert.rejects(start(core, repo, { baseBranch: 'нет-такой' }), /Ветка нет-такой не найдена/);
  assert.deepEqual(await core.listRuns(), []);
  assert.equal(g('branch', '--list', 'purpleflow/*'), '');
});

test('режим «ветка»: второй прогон на той же копии не стартует', unix, async (t) => {
  const { core, repo, save } = setup(t);
  save({ status: 'waiting', next: 'gate2', workspace: 'branch' });
  await assert.rejects(start(core, repo, { workspace: 'branch' }));
});

test('удаление: идущий прогон останавливается, копия и ветка убраны, из очереди не возвращается', unix, async (t) => {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let started = false;
  const { core, k, repo, g, until } = setup(t, async () => {
    started = true;
    await gate;
    return okReply('Готово');
  });
  t.after(() => release());
  const id = (await start(core, repo)).runId!;
  await until(id, () => started);
  const { worktreePath, branch } = k.mustLoad(id);
  setTimeout(release, 100);
  await core.dispatch({ type: 'run.delete', runId: id, deleteBranch: true });
  assert.equal(k.store.load(id), null);
  assert.ok(!fs.existsSync(worktreePath));
  assert.equal(g('branch', '--list', branch), '');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(k.store.load(id), null, 'запоздалое сохранение стадии не воскрешает прогон');
});

test('удаление с веткой, открытой в проекте: отказ, ничего не тронуто', unix, async (t) => {
  const { core, k, g, save } = setup(t);
  g('checkout', '-q', '-b', 'purpleflow/open');
  const run = save({ status: 'stopped', workspace: 'branch', branch: 'purpleflow/open', originalBranch: 'main' });
  await assert.rejects(core.dispatch({ type: 'run.delete', runId: run.id, deleteBranch: true }), /git checkout main/);
  assert.ok(k.store.load(run.id));
  assert.equal(g('branch', '--show-current'), 'purpleflow/open');
});

test('пропуск проверок: условия и переход дальше', unix, async (t) => {
  const { core, k, save, until } = setup(t);
  const skip = (runId: string) => core.dispatch({ type: 'run.skipChecks', runId });
  await assert.rejects(skip(save({ status: 'waiting', next: 'gate1' }).id), /только на реализации или проверках/);
  await assert.rejects(skip(save({ status: 'stopped', next: 'tests' }).id), /ещё ни разу не завершилась/);
  const run = save({
    status: 'stopped',
    next: 'tests',
    quickFix: true,
    attempts: [
      { stage: 'implement', attempt: 1, startedAt: '', status: 'done' },
      { stage: 'tests', attempt: 1, startedAt: '', status: 'running' },
    ],
  });
  await skip(run.id);
  const r = await until(run.id, (x) => x.status === 'waiting');
  assert.equal(r.next, 'gate2');
  assert.equal(r.attempts[1].status, 'stopped');
  assert.equal(r.tests.at(-1)!.passed, true);
  assert.match(r.tests.at(-1)!.output, /пропущены человеком/);
  assert.equal(k.driving.has(run.id), false);
});

test('повтор визуальной проверки: условия', unix, async (t) => {
  const { core, save } = setup(t);
  const rerun = (runId: string) => core.dispatch({ type: 'run.rerunVisual', runId });
  const done = [{ stage: 'implement', attempt: 1, startedAt: '', status: 'done' }];
  await assert.rejects(rerun(save({ status: 'finished' }).id), /уже завершён/);
  await assert.rejects(rerun(save({ status: 'stopped' }).id), /Реализации ещё не было/);
  await assert.rejects(rerun(save({ status: 'stopped', attempts: done as never }).id), /Нет команды запуска/);
});

// ——— Решения на гейтах ———

function gates(t: { after: (fn: () => void) => void }) {
  const s = setup(t);
  const drives: string[] = [];
  s.k.engine = { ...s.k.engine, drive: async (r: RunFile) => void drives.push(r.id) };
  return { ...s, drives };
}

test('гейт: решение только когда прогон ждёт', unix, async (t) => {
  const { k, save } = gates(t);
  await assert.rejects(decide(k, save({ status: 'running', next: 'gate1' }).id, 'approve'), /не ждёт решения/);
  await assert.rejects(decide(k, save({ status: 'waiting', next: 'implement' }).id, 'approve'), /не ждёт решения/);
});

test('план: принять, вернуть, принять после возврата с реализации', unix, async (t) => {
  const { k, save, drives } = gates(t);
  const ok = save({ status: 'waiting', next: 'gate1', mode: 'epic', feedback: { source: 'human', text: 'старое' } });
  await decide(k, ok.id, 'approve');
  const r = k.mustLoad(ok.id);
  assert.deepEqual([r.next, r.status, r.phase, r.feedback], ['implement', 'running', 1, undefined]);
  assert.equal(drives.at(-1), ok.id);

  const back = save({ status: 'waiting', next: 'gate1', planRetries: 2 });
  await decide(k, back.id, 'reject', 'Без новых таблиц');
  const b = k.mustLoad(back.id);
  assert.deepEqual([b.next, b.planRetries], ['plan', 0]);
  assert.match(b.feedback!.text, /Без новых таблиц/);

  const replan = save({ status: 'waiting', next: 'gate1', replanNote: 'другой подход' });
  await decide(k, replan.id, 'approve');
  const n = k.mustLoad(replan.id);
  assert.match(n.feedback!.text, /План обновлён[\s\S]*другой подход/);
  assert.equal(n.replanNote, undefined);
});

test('вопросы: «принять» без ответов — дальше по задаче', unix, async (t) => {
  const { k, save } = gates(t);
  const run = save({ status: 'waiting', next: 'gate0', clarify: { questions: [] } as never });
  await decide(k, run.id, 'approve');
  const r = k.mustLoad(run.id);
  assert.equal(r.next, 'plan');
  assert.equal(r.clarify!.skipped, true);
});

test('приёмка: принять, вернуть с новой попыткой, быстрая правка', unix, async (t) => {
  const { k, save } = gates(t);
  const ok = save({ status: 'waiting', next: 'gate2' });
  await decide(k, ok.id, 'approve');
  assert.equal(k.mustLoad(ok.id).next, 'finish');

  const back = save({ status: 'waiting', next: 'gate2', implAttemptsUsed: 3, implAttemptsLimit: 3 });
  await decide(k, back.id, 'reject', 'Не то');
  const b = k.mustLoad(back.id);
  assert.deepEqual([b.next, b.implAttemptsLimit], ['implement', 4]);
  assert.match(b.feedback!.text, /Не то/);

  const fix = save({ status: 'waiting', next: 'gate2' });
  await decide(k, fix.id, 'fix', 'Поправь цвет');
  const f = k.mustLoad(fix.id);
  assert.equal(f.next, 'implement');
  assert.equal(f.quickFix, true);
  assert.match(f.feedback!.text, /Поправь цвет/);
});

test('попытки исчерпаны: ещё попытка с прошлой обратной связью, принять как есть, остановить', unix, async (t) => {
  const { k, save } = gates(t);
  const fails = [{ stage: 'tests', attempt: 1, startedAt: '', status: 'failed' }] as never;
  const more = save({ status: 'waiting', next: 'limit', implAttemptsUsed: 3, feedback: { source: 'review', text: 'упал тест' } });
  await decide(k, more.id, 'approve', 'Посмотри на дату');
  const m = k.mustLoad(more.id);
  assert.deepEqual([m.next, m.implAttemptsLimit, m.feedback!.source], ['implement', 4, 'review']);
  assert.match(m.feedback!.text, /упал тест[\s\S]*Посмотри на дату/);

  const accept = save({ status: 'waiting', next: 'limit', attempts: fails, feedback: { source: 'review', text: 'x' } });
  await decide(k, accept.id, 'accept');
  assert.deepEqual([k.mustLoad(accept.id).next, k.mustLoad(accept.id).feedback], ['gate2', undefined]);

  const toVisual = save({ status: 'waiting', next: 'limit', visual: true, attempts: fails });
  await decide(k, toVisual.id, 'accept');
  assert.equal(k.mustLoad(toVisual.id).next, 'visual');

  const stop = save({ status: 'waiting', next: 'limit' });
  await decide(k, stop.id, 'cancel');
  assert.equal(k.mustLoad(stop.id).status, 'stopped');
});

test('отмена на плане: прогон отменён, фоновые проверки прекращены', unix, async (t) => {
  const { k, save, drives } = gates(t);
  const run = save({ status: 'waiting', next: 'gate1' });
  k.basePrep.set(run.id, {} as never);
  await decide(k, run.id, 'cancel');
  const r = k.mustLoad(run.id);
  assert.equal(r.status, 'cancelled');
  assert.ok(r.finishedAt);
  assert.equal(k.basePrep.has(run.id), false);
  assert.ok(!drives.includes(run.id));
});

// ——— Реализация, ревью, рабочая копия ———

test('реализация: сессия пропала — начинаем заново; сбой агента не тратит попытку; название быстрой правки', unix, async (t) => {
  const calls: AgentRunOptions[] = [];
  let mode: 'lost' | 'fail' | 'ok' = 'lost';
  const { k, save } = setup(t, (o) => {
    calls.push(o);
    if (mode === 'fail') return { ok: false, text: '', error: 'Нет ключа', usage: emptyUsage() };
    if (mode === 'lost' && o.resume) return { ok: false, text: '', error: 'No conversation found', usage: emptyUsage() };
    return okReply('Сделано\nНАЗВАНИЕ: Короткое название');
  });
  const run = save({ executorSession: 'old', implAttemptsUsed: 0 });
  await stageImplement(k, run);
  assert.equal(calls[0].resume, 'old');
  assert.ok(calls[1].sessionId && calls[1].sessionId !== 'old', 'новая сессия');
  assert.equal(run.executorSession, calls[1].sessionId);
  assert.equal(run.implAttemptsUsed, 1);
  assert.equal(run.title, 'Короткое название');

  mode = 'fail';
  await assert.rejects(stageImplement(k, run), /Нет ключа/);
  assert.equal(run.implAttemptsUsed, 1, 'попытка не потрачена');
});

test('ревью: второй ревьюер делит замечания на блокирующие, заметки и отклонённые', unix, async (t) => {
  const { k, repo, save } = setup(t, (o) => {
    if (/второй, независимый ревьюер/.test(o.prompt))
      return okReply(
        JSON.stringify({
          items: [
            { index: 1, verdict: 'confirmed', reason: 'падает на null' },
            { index: 2, verdict: 'minor', reason: 'косметика' },
            { index: 3, verdict: 'rejected', reason: 'не так' },
          ],
        }),
      );
    return okReply(JSON.stringify({ blocking: ['a', 'b', 'c'].map((message) => ({ message })), notes: [{ message: 'заметка' }] }));
  });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'правка\n');
  const run = save({ next: 'review' });
  await stageReview(k, run);
  const r = run.reviews.at(-1)!;
  assert.deepEqual(
    r.blocking.map((x) => x.message),
    ['a\n\nСценарий: падает на null'],
  );
  assert.deepEqual(
    r.notes.map((x) => x.message),
    ['заметка', 'b (второй ревьюер: не блокирует — косметика)'],
  );
  assert.equal(run.next, 'implement');
  assert.match(run.feedback!.text, /a\n\nСценарий/);
});

test('ревью: большой дифф — списком файлов, ответ не JSON — ошибка стадии', unix, async (t) => {
  const prompts: string[] = [];
  const { k, repo, save } = setup(t, (o) => {
    prompts.push(o.prompt);
    return okReply('Посмотрел, всё хорошо');
  });
  // Один файл урезается до FILE_CAP: списком идёт только суммарно большой дифф.
  for (const f of ['big1.txt', 'big2.txt', 'big3.txt']) fs.writeFileSync(path.join(repo, f), 'строка\n'.repeat(60_000));
  await assert.rejects(stageReview(k, save({ next: 'review' })), /не в формате JSON/);
  assert.match(prompts[0], /Изменённые файлы — по важности/);
  assert.match(prompts[0], /big1\.txt/);
  assert.ok(!prompts[0].includes('строка\nстрока\nстрока'), 'сам дифф в промпт не попал');
});

test('файлы окружения: копируются только недостающие и только изнутри проекта', unix, async (t) => {
  const { k, root, repo, save } = setup(t);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(root, 'outside.env'), 'SECRET\n');
  fs.writeFileSync(path.join(repo, '.env'), 'NEW\n');
  fs.mkdirSync(path.join(repo, 'apps'));
  fs.writeFileSync(path.join(repo, 'apps', '.env'), 'NESTED\n');
  fs.writeFileSync(path.join(repo, '.env.keep'), 'ИЗ ПРОЕКТА\n');
  fs.writeFileSync(path.join(wt, '.env.keep'), 'ИЗ КОПИИ\n');
  const run = save({ worktreePath: wt, envFiles: ['.env', 'apps/.env', '.env.keep', '../outside.env', 'нет.env'], worktreeRemoved: true });
  copyEnvFiles(k, run);
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'NEW\n');
  assert.equal(fs.readFileSync(path.join(wt, 'apps', '.env'), 'utf8'), 'NESTED\n');
  assert.equal(fs.readFileSync(path.join(wt, '.env.keep'), 'utf8'), 'ИЗ КОПИИ\n', 'свои правки не затираются');
  assert.deepEqual(fs.readdirSync(wt).sort(), ['.env', '.env.keep', 'apps'], 'файл снаружи проекта не скопирован');
});

test('зависимости: копия node_modules; lock-файлы совпали — установка пропускается, отличаются — нет', unix, async (t) => {
  const { k, root, repo, save } = setup(t);
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'i.js'), 'x');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), 'v1');
  const same = path.join(root, 'same');
  fs.mkdirSync(same);
  fs.writeFileSync(path.join(same, 'package-lock.json'), 'v1');
  const a = save({ worktreePath: same, worktreeRemoved: true });
  await cloneDeps(k, a);
  assert.ok(fs.existsSync(path.join(same, 'node_modules', 'pkg', 'i.js')));
  assert.equal(a.prepared, true);

  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'package-lock.json'), 'v2');
  const b = save({ worktreePath: other, worktreeRemoved: true });
  await cloneDeps(k, b);
  assert.ok(fs.existsSync(path.join(other, 'node_modules', 'pkg', 'i.js')));
  assert.equal(b.prepared, undefined);
});
