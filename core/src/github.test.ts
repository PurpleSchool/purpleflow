// GitHub-обвязка на фейковом gh: скрипт отдаёт заготовленный ответ, аргументы пишет в файл.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPr, failedJobLog, parsePrUrl, prComments, prReadiness, prStatus } from './github.js';

const unix = { skip: process.platform === 'win32' };
const URL_ = 'https://github.com/acme/app/pull/42';

function fakeGh(t: { after: (fn: () => void) => void }, stdout: string, code = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'gh');
  const out = path.join(dir, 'out.txt');
  fs.writeFileSync(out, stdout);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${out}"\nexit ${code}\n`, { mode: 0o755 });
  return { bin, dir, args: () => fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n') };
}

const pr = (over: object = {}) =>
  JSON.stringify({
    number: 42,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [],
    mergeCommit: null,
    url: URL_,
    ...over,
  });

test('parsePrUrl', () => {
  assert.deepEqual(parsePrUrl(URL_), { owner: 'acme', name: 'app', number: 42 });
  assert.deepEqual(parsePrUrl(`${URL_}/files`), { owner: 'acme', name: 'app', number: 42 });
  assert.equal(parsePrUrl('https://gitlab.com/acme/app/merge_requests/1'), null);
});

test('prStatus: проверки двух видов — CheckRun и StatusContext', unix, async (t) => {
  const gh = fakeGh(
    t,
    pr({
      statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS', name: 'lint' },
        { status: 'COMPLETED', conclusion: 'SKIPPED', name: 'optional' },
        { status: 'IN_PROGRESS', conclusion: '', name: 'build' },
        { status: 'COMPLETED', conclusion: 'FAILURE', name: 'test', detailsUrl: 'https://ci/1' },
        { state: 'PENDING', context: 'ext/pending' },
        { state: 'SUCCESS', context: 'ext/ok' },
        { state: 'ERROR', context: 'ext/bad', targetUrl: 'https://ci/2' },
      ],
    }),
  );
  const s = await prStatus(gh.bin, gh.dir, process.env, URL_);
  assert.deepEqual(s.checks, { total: 7, passed: 3, failed: 2, pending: 2 });
  assert.deepEqual(s.failedChecks, [
    { name: 'test', url: 'https://ci/1' },
    { name: 'ext/bad', url: 'https://ci/2' },
  ]);
  assert.equal(s.mergeable, true);
  assert.equal(s.review, null);
});

test('prStatus: конфликт — это и отставание; без проверок и с коммитом слияния', unix, async (t) => {
  const gh = fakeGh(t, pr({ mergeable: 'CONFLICTING', statusCheckRollup: null, mergeCommit: { oid: 'abc' }, reviewDecision: 'APPROVED' }));
  const s = await prStatus(gh.bin, gh.dir, process.env, URL_);
  assert.equal(s.conflicts, true);
  assert.equal(s.behind, true);
  assert.equal(s.mergeable, false);
  assert.equal(s.mergeCommit, 'abc');
  assert.equal(s.review, 'APPROVED');
  assert.equal(s.checks.total, 0);
});

test('gh упал — ошибка с его сообщением', unix, async (t) => {
  const gh = fakeGh(t, 'no such pr', 1);
  await assert.rejects(prStatus(gh.bin, gh.dir, process.env, URL_), /no such pr/);
});

test('createPr: ссылка среди вывода, аргументы передаются как есть', unix, async (t) => {
  const gh = fakeGh(t, `Creating pull request\n${URL_}\n`);
  const r = await createPr(gh.bin, gh.dir, process.env, {
    base: 'main',
    head: 'purpleflow/x',
    title: 'Заголовок с "кавычками"',
    bodyFile: 'b.md',
  });
  assert.deepEqual(r, { url: URL_, number: 42 });
  assert.deepEqual(gh.args().slice(0, 2), ['pr', 'create']);
  assert.ok(gh.args().includes('Заголовок с "кавычками"'));
});

test('prComments: обсуждения, итоги ревью с текстом и комментарии — по времени', unix, async (t) => {
  const gh = fakeGh(
    t,
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            title: 'PR',
            reviews: {
              nodes: [
                {
                  id: 'r1',
                  author: { login: 'ann' },
                  body: 'Поправьте',
                  state: 'CHANGES_REQUESTED',
                  submittedAt: '2026-01-02T00:00:00Z',
                  url: 'u1',
                },
                { id: 'r2', author: { login: 'ann' }, body: '  ', state: 'APPROVED', submittedAt: '2026-01-05T00:00:00Z', url: 'u2' },
              ],
            },
            comments: { nodes: [{ id: 'c1', author: null, body: 'общий', createdAt: '2026-01-01T00:00:00Z', url: 'u3' }] },
            reviewThreads: {
              nodes: [
                {
                  id: 't1',
                  isResolved: true,
                  isOutdated: false,
                  path: 'a.ts',
                  line: null,
                  originalLine: 7,
                  comments: {
                    nodes: [
                      { author: { login: 'bob' }, body: 'тут', createdAt: '2026-01-03T00:00:00Z', url: 'u4' },
                      { author: null, body: 'ответ', createdAt: '2026-01-04T00:00:00Z', url: 'u5' },
                    ],
                  },
                },
                { id: 't2', isResolved: false, isOutdated: false, path: 'b.ts', line: 1, originalLine: 1, comments: { nodes: [] } },
              ],
            },
          },
        },
      },
    }),
  );
  const { title, comments } = await prComments(gh.bin, gh.dir, process.env, URL_);
  assert.equal(title, 'PR');
  assert.deepEqual(
    comments.map((c) => c.id),
    ['c1', 'r1', 't1'],
  );
  assert.equal(comments[0].author, 'ghost');
  assert.equal(comments[2].line, 7);
  assert.equal(comments[2].resolved, true);
  assert.deepEqual(comments[2].replies, [{ author: 'ghost', body: 'ответ', at: '2026-01-04T00:00:00Z' }]);
  assert.ok(gh.args().includes('n=42'));
});

test('prComments: ошибки GraphQL, PR нет, ссылка не на PR', unix, async (t) => {
  const bad = fakeGh(t, JSON.stringify({ errors: [{ message: 'нет доступа' }] }));
  await assert.rejects(prComments(bad.bin, bad.dir, process.env, URL_), /нет доступа/);
  const none = fakeGh(t, JSON.stringify({ data: { repository: {} } }));
  await assert.rejects(prComments(none.bin, none.dir, process.env, URL_), /PR не найден/);
  await assert.rejects(prComments(none.bin, none.dir, process.env, 'https://example.test'), /ссылку на PR/);
});

test('failedJobLog: только ссылки на Actions; префиксы job и step срезаются', unix, async (t) => {
  const gh = fakeGh(t, 'job\tstep\t2026-01-01T00:00:00.000Z ошибка сборки\njob\tstep\t2026-01-01T00:00:01.000Z \n');
  assert.equal(await failedJobLog(gh.bin, gh.dir, process.env, 'https://ci.example/build/1'), null);
  const log = await failedJobLog(gh.bin, gh.dir, process.env, 'https://github.com/acme/app/actions/runs/11/job/22');
  assert.equal(log, 'ошибка сборки');
  assert.deepEqual(gh.args().slice(0, 5), ['run', 'view', '11', '--job', '22']);
  const failed = fakeGh(t, '', 1);
  assert.equal(await failedJobLog(failed.bin, failed.dir, process.env, 'https://github.com/a/b/actions/runs/1/job/2'), null);
});

test('prReadiness: нет gh, нет origin, origin не на GitHub', unix, async (t) => {
  assert.match((await prReadiness(null, 'git', process.cwd(), process.env)) ?? '', /GitHub CLI/);
  const gh = fakeGh(t, '');
  const fakeGit = (url: string, code = 0) => {
    const bin = path.join(gh.dir, `git-${code}-${url.length}`);
    fs.writeFileSync(bin, `#!/bin/sh\necho "${url}"\nexit ${code}\n`, { mode: 0o755 });
    return bin;
  };
  assert.match((await prReadiness(gh.bin, fakeGit('', 2), gh.dir, process.env)) ?? '', /нет удалённого/);
  assert.match((await prReadiness(gh.bin, fakeGit('git@gitlab.com:a/b.git'), gh.dir, process.env)) ?? '', /не на GitHub/);
  assert.equal(await prReadiness(gh.bin, fakeGit('git@github.com:a/b.git'), gh.dir, process.env), null);
});
