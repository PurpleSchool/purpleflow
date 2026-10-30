import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCommand, findEnvFiles } from './detect.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-detect-'));
  const pkg = (rel: string, scripts: Record<string, string>) => {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    fs.writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify({ scripts }));
  };
  pkg('apps/api', { 'start:dev': 'nest start --watch', test: 'jest' });
  pkg('apps/web', { dev: 'next dev', lint: 'eslint' });
  return dir;
}

test('checkCommand: нет скрипта — подсказка и исправление с учётом cd в скобках', () => {
  const dir = repo();
  const issues = checkCommand(dir, '(cd apps/api && PORT=4000 npm run dev) & (cd apps/web && npm run dev -- -p {port})');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /apps\/api\/package\.json нет скрипта «dev»/);
  assert.equal(issues[0].fix, '(cd apps/api && PORT=4000 npm run start:dev) & (cd apps/web && npm run dev -- -p {port})');
  assert.deepEqual(checkCommand(dir, '(cd apps/web && npm run lint) && (cd apps/api && npm test)'), []);
  assert.match(checkCommand(dir, 'cd apps/nope && npm run x')[0].message, /Нет файла apps\/nope\/package\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findEnvFiles: .env-файлы без шаблонов и node_modules', () => {
  const dir = repo();
  for (const f of ['apps/api/.env', 'apps/api/.env.example', 'apps/web/.env.local', 'node_modules/x/.env']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'X=1');
  }
  assert.deepEqual(findEnvFiles(dir), ['apps/api/.env', 'apps/web/.env.local']);
  fs.rmSync(dir, { recursive: true, force: true });
});
