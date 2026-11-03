// Pull Request: настоящий git с локальным bare-remote в каталоге github.com и фейковый gh в PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Kernel } from './kernel.js';
import { getDiff, getChangedFiles } from './services/runs.js';
import {
  getPrDetails,
  getPrStatus,
  listBranches,
  merge,
  mergePrOf,
  openPr,
  prBody,
  prFollowup,
  prReady,
  updateBranch,
} from './services/pr.js';
import type { CoreSettings, PrFollowupItem, RunFile } from './types.js';

const unix = { skip: process.platform === 'win32' };
const URL_ = 'https://github.com/acme/app/pull/7';

const prJson = (over: object = {}) =>
  JSON.stringify({
    number: 7,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'FAILURE', name: 'test', detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/2' },
    ],
    mergeCommit: null,
    url: URL_,
    ...over,
  });

function setup(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pr-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'github.com', 'acme', 'app.git');
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(repo);
  const at =
    (cwd: string) =>
    (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd })
        .toString()
        .trim();
  const g = at(repo);
  at(remote)('init', '-q', '--bare', '-b', 'main');
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  g('push', '-q', 'origin', 'main');
  const baseCommit = g('rev-parse', 'HEAD');
  g('worktree', 'add', '-q', '-b', 'purpleflow/x', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  at(wt)('add', '-A');
  at(wt)('commit', '-qm', 'задача');

  // gh отвечает по команде; ответ на pr view берёт из файла, чтобы тест мог менять состояние PR.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const view = path.join(root, 'view.json');
  const calls = path.join(root, 'calls');
  const graphql = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          title: 'Заголовок',
          reviews: { nodes: [] },
          comments: { nodes: [{ id: 'c1', author: { login: 'ann' }, body: 'Поправь', createdAt: '2026-01-01T00:00:00Z', url: 'u' }] },
          reviewThreads: { nodes: [] },
        },
      },
    },
  });
  fs.writeFileSync(view, prJson());
  fs.writeFileSync(path.join(root, 'graphql.json'), graphql);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "pr create") echo "${URL_}" ;;
  "pr view") cat "${view}" ;;
  "api graphql") cat "${root}/graphql.json" ;;
  "run view") printf 'job\\tstep\\t2026-01-01T00:00:00.000Z упал тест\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  const settings = { toolPaths: {} } as unknown as CoreSettings;
  const k = new Kernel({
    dataDir: path.join(root, 'data'),
    promptsDir: root,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    getSettings: () => settings,
  });
  const drives: RunFile[] = [];
  k.engine = { drive: async (r: RunFile) => void drives.push(r) } as never;
  const run = {
    id: 'run-1',
    title: 'Заголовок',
    task: 'Сделай b',
    changeId: 'c',
    mode: 'task',
    status: 'finished',
    next: 'finish',
    workspace: 'worktree',
    projectPath: repo,
    worktreePath: wt,
    branch: 'purpleflow/x',
    baseBranch: 'main',
    baseCommit,
    agents: { reviewer: 'codex' },
    models: {},
    attempts: [],
    tests: [],
    reviews: [],
    implAttemptsUsed: 1,
    createdAt: '2026-01-01',
  } as unknown as RunFile;
  k.store.save(run);
  return {
    k,
    g,
    gw: at(wt),
    wt,
    repo,
    remoteGit: at(remote),
    calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n'),
    setView: (over: object) => fs.writeFileSync(view, prJson(over)),
    drives,
    withPr: () => k.store.save({ ...k.mustLoad('run-1'), pr: { url: URL_, number: 7, base: 'main', createdAt: '2026-01-01' } }),
  };
}

test('openPr: ветка на origin, описание из прогона, повторно нельзя', unix, async (t) => {
  const { k, remoteGit, calls } = setup(t);
  assert.equal(await prReady(k, 'run-1'), null);
  await assert.rejects(openPr(k, 'run-1', '  '), /Выберите ветку/);
  await openPr(k, 'run-1', 'main');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.pr?.url, r.pr?.number, r.pr?.base], [URL_, 7, 'main']);
  assert.ok(remoteGit('rev-parse', 'purpleflow/x'), 'ветка отправлена');
  assert.ok(calls().some((c) => c.startsWith('pr create') && c.includes('--head purpleflow/x')));
  await assert.rejects(openPr(k, 'run-1', 'main'), /уже открыт/);
  assert.ok(!fs.readdirSync(os.tmpdir()).includes('purpleflow-pr-run-1.md'), 'временное описание убрано');
});

test('openPr: только для завершённого прогона', unix, async (t) => {
  const { k } = setup(t);
  k.store.save({ ...k.mustLoad('run-1'), status: 'running' });
  await assert.rejects(openPr(k, 'run-1', 'main'), /завершённого/);
});

test('prBody: собирает то, что есть, и пропускает пустое', unix, async (t) => {
  const { k } = setup(t);
  const r = k.mustLoad('run-1');
  const empty = await prBody(k, r);
  assert.match(empty, /## Задача\n\nСделай b/);
  assert.doesNotMatch(empty, /## Ревью|## Проверки|## Визуальная/);
  const full = await prBody(k, {
    ...r,
    attempts: [{ stage: 'implement', attempt: 1, startedAt: '', status: 'done', output: 'Добавил b' }],
    tests: [{ checks: [{ kind: 'test', command: 'npm test', passed: true }] }],
    reviews: [{ at: '', blocking: [], notes: [{ file: 'b.txt', line: 2, message: 'заметка' }] }],
    visuals: [{ blocking: [], notes: [], shots: [{ caption: 'Главная', file: 'x.png' }] }],
  } as unknown as RunFile);
  assert.match(full, /## Что сделано\n\nДобавил b/);
  assert.match(full, /Тесты: ✅ `npm test`/);
  assert.match(full, /Блокирующих замечаний нет[\s\S]*`b\.txt:2` — заметка/);
  assert.match(full, /Главная/);
});

test('статус и детали: упавшие проверки — среди замечаний, влитый на GitHub PR отмечается у прогона', unix, async (t) => {
  const { k, withPr, setView } = setup(t);
  assert.equal(await getPrStatus(k, 'run-1'), null, 'без PR');
  withPr();
  const d = await getPrDetails(k, 'run-1');
  assert.equal(d?.title, 'Заголовок');
  assert.deepEqual(
    d?.comments.map((c) => c.kind),
    ['check', 'comment'],
  );
  assert.equal(k.mustLoad('run-1').merged, undefined);
  setView({ state: 'MERGED', mergeCommit: { oid: 'abc' } });
  await getPrStatus(k, 'run-1');
  assert.deepEqual([k.mustLoad('run-1').merged?.into, k.mustLoad('run-1').merged?.commit], ['main', 'abc']);
});

test('mergePrOf: без PR — ошибка; с PR — слияние через gh', unix, async (t) => {
  const { k, withPr, calls, setView } = setup(t);
  await assert.rejects(mergePrOf(k, 'run-1'), /нет PR/);
  withPr();
  setView({ state: 'MERGED' });
  await mergePrOf(k, 'run-1');
  assert.ok(calls().includes(`pr merge ${URL_} --merge`));
  assert.ok(k.mustLoad('run-1').merged);
});

test('prFollowup: новый круг с логом упавшей проверки; условия запуска', unix, async (t) => {
  const { k, withPr, drives } = setup(t);
  const items: PrFollowupItem[] = [
    { id: '1', kind: 'check', author: 'CI', body: 'test', at: '', url: 'https://github.com/acme/app/actions/runs/1/job/2' },
    { id: '2', kind: 'thread', author: 'ann', body: 'Поправь', at: '', path: 'b.txt', line: 1 },
  ] as unknown as PrFollowupItem[];
  await assert.rejects(prFollowup(k, 'run-1', items), /нет PR/);
  withPr();
  await assert.rejects(prFollowup(k, 'run-1', []), /Выберите замечания/);
  await prFollowup(k, 'run-1', items, 'и ещё вот это');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.status, r.next, r.prRound, r.implAttemptsLimit], ['running', 'implement', 2, 4]);
  assert.match(r.feedback!.text, /Упала проверка CI «test»[\s\S]*упал тест/);
  assert.match(r.feedback!.text, /b\.txt:1 — @ann: Поправь/);
  assert.match(r.feedback!.text, /и ещё вот это/);
  assert.equal(drives.length, 1);
  await assert.rejects(prFollowup(k, 'run-1', items), /когда прогон завершён/);
});

test('prFollowup: удалённую при уборке копию создаёт заново', unix, async (t) => {
  const { k, withPr, wt, g } = setup(t);
  withPr();
  g('worktree', 'remove', '--force', wt);
  k.store.save({ ...k.mustLoad('run-1'), worktreeRemoved: true });
  await prFollowup(k, 'run-1', [], 'доработай');
  assert.ok(fs.existsSync(path.join(wt, 'b.txt')));
  assert.equal(k.mustLoad('run-1').worktreeRemoved, undefined);
});

test('updateBranch без конфликтов: дальше проверки, дифф прогона не включает влитое из базы', unix, async (t) => {
  const { k, withPr, g, drives } = setup(t);
  withPr();
  await assert.rejects(updateBranch(k, 'run-1'), /уже содержит всё/);

  fs.writeFileSync(path.join(k.mustLoad('run-1').projectPath, 'c.txt'), 'из базы\n');
  g('add', '-A');
  g('commit', '-qm', 'новое в main');
  g('push', '-q', 'origin', 'main');
  await updateBranch(k, 'run-1');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.status, r.next, r.mergeOnly, r.prRound], ['running', 'tests', true, 2]);
  assert.equal(r.diffFrom, g('rev-parse', 'main'));
  assert.equal(r.prRounds?.at(-1)?.kind, 'update');
  assert.equal(drives.length, 1);

  // Завершили круг: в диффе только работа задачи.
  k.store.save({ ...r, status: 'finished' });
  assert.deepEqual(
    (await getDiff(k, 'run-1')).map((f) => f.path),
    ['b.txt'],
  );
  assert.deepEqual(await getChangedFiles(k, 'run-1'), ['b.txt']);
});

test('updateBranch с конфликтом: разрешать будет исполнитель', unix, async (t) => {
  const { k, withPr, g, gw, wt } = setup(t);
  withPr();
  fs.writeFileSync(path.join(wt, 'a.txt'), 'из задачи\n');
  gw('add', '-A');
  gw('commit', '-qm', 'правка a');
  fs.writeFileSync(path.join(k.mustLoad('run-1').projectPath, 'a.txt'), 'из базы\n');
  g('add', '-A');
  g('commit', '-qm', 'новое в main');
  g('push', '-q', 'origin', 'main');
  await updateBranch(k, 'run-1');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.next, r.roundFiles, r.prRounds?.at(-1)?.conflicts], ['implement', ['a.txt'], ['a.txt']]);
  assert.match(r.feedback!.text, /в файлах конфликты/);
  assert.match(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), /<<<<<<</);
});

test('merge и listBranches: своя ветка не предлагается, результат записан', unix, async (t) => {
  const { k, g, repo } = setup(t);
  const list = await listBranches(k, 'run-1');
  assert.deepEqual([list.branches, list.suggested], [['main'], 'main']);
  await assert.rejects(merge(k, 'run-1', ' '), /Выберите ветку/);
  await merge(k, 'run-1', 'main');
  assert.equal(k.mustLoad('run-1').merged?.commit, g('rev-parse', 'main'));
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
});
