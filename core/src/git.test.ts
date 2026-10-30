import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Git } from './git.js';

test('дифф для окна и коммит не конфликтуют за index.lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-git-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const base = g('rev-parse', 'HEAD').toString().trim();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
  const git = new Git('git', process.env);
  const [d1, sha, d2] = await Promise.all([git.diff(dir, base), git.commitAll(dir, 'x'), git.diff(dir, base)]);
  assert.equal(d1.length, 40);
  assert.equal(d2.length, 40);
  assert.notEqual(sha, base);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge: чистая копия, грязная копия, ветка вне копии, конфликт', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-merge-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-merge-wt-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir }).toString();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  g('branch', 'dev');
  g('checkout', '-q', '-b', 'purpleflow/x');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  g('add', '-A');
  g('commit', '-qm', 'feature');
  g('checkout', '-q', 'main');
  const git = new Git('git', process.env);

  // 1. main открыта и чистая — вливаем прямо в неё.
  const sha = await git.merge(dir, 'purpleflow/x', 'main', 'Merge purpleflow/x', tmp);
  assert.equal(g('rev-parse', 'main').trim(), sha);
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));

  // 2. dev нигде не открыта — вливаем во временной worktree, рабочая копия не меняется.
  const before = g('rev-parse', 'HEAD').trim();
  await git.merge(dir, 'purpleflow/x', 'dev', 'Merge purpleflow/x', tmp);
  assert.equal(g('rev-parse', 'HEAD').trim(), before);
  assert.match(g('log', '--format=%s', '-1', 'dev'), /Merge purpleflow\/x/);
  assert.equal(fs.readdirSync(tmp).length, 0);

  // 3. Незакоммиченные изменения в открытой ветке — отказ без изменений.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  await assert.rejects(git.merge(dir, 'purpleflow/x', 'main', 'm', tmp), /незакоммиченные/);
  g('checkout', '--', 'a.txt');

  // 4. Конфликт — слияние отменено, дерево чистое.
  g('checkout', '-q', '-b', 'purpleflow/y', 'main~1');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'other\n');
  g('add', '-A');
  g('commit', '-qm', 'conflict');
  g('checkout', '-q', 'main');
  const headBefore = g('rev-parse', 'HEAD').trim();
  await assert.rejects(git.merge(dir, 'purpleflow/y', 'main', 'm', tmp), /Конфликт[\s\S]*b\.txt/);
  assert.equal(g('rev-parse', 'HEAD').trim(), headBefore);
  assert.equal(g('status', '--porcelain').trim(), '');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('commitAll: изменений нет, кроме исключённого файла — коммит не создаётся и не падает', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-noop-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir }).toString();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const base = g('rev-parse', 'HEAD').trim();
  fs.mkdirSync(path.join(dir, 'openspec/changes/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/changes/x/run.json'), '{}');
  const sha = await new Git('git', process.env).commitAll(dir, 'x', ['openspec/changes/x/run.json']);
  assert.equal(sha, base);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitAll: исключение файла из .gitignore не ломает коммит', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-ign-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir }).toString();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const before = g('rev-parse', 'HEAD').trim();
  const sha = await new Git('git', process.env).commitAll(dir, 'x', ['.env']);
  assert.notEqual(sha, before);
  assert.equal(g('show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restoreFromBase: изменённый артефакт — из базы, новый — удалён, остальное не тронуто', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-git-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), 'old\n');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'a\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const base = g('rev-parse', 'HEAD').toString().trim();
  fs.writeFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), 'new\n');
  fs.writeFileSync(path.join(dir, 'next-env.d.ts'), 'x\n');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'b\n');
  const git = new Git('git', process.env);
  const changed = await git.changedFiles(dir, base);
  await git.restoreFromBase(
    dir,
    base,
    changed.filter((f) => f !== 'app.ts'),
  );
  assert.equal(fs.readFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), 'utf8'), 'old\n');
  assert.ok(!fs.existsSync(path.join(dir, 'next-env.d.ts')));
  assert.equal(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8'), 'b\n');
  assert.deepEqual(await git.changedFiles(dir, base), ['app.ts']);
  fs.rmSync(dir, { recursive: true, force: true });
});
