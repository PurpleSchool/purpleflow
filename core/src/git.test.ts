import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Git } from './git.js';

test('дифф для окна и коммит не конфликтуют за index.lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psflow-git-'));
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
