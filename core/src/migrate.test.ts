import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUN_VERSION, migrateRun } from './migrate.js';

const v1 = { version: 1, id: 'x', status: 'finished', agents: { planner: 'codex' } } as never;

test('migrateRun: у прогона v1 появляются режим, место работы и агенты по умолчанию', () => {
  const r = migrateRun(v1);
  assert.equal(r.version, RUN_VERSION);
  assert.equal(r.mode, 'task');
  assert.equal(r.workspace, 'worktree');
  assert.deepEqual(r.agents, { planner: 'codex', executor: 'claude', reviewer: 'codex' });
});

test('migrateRun: текущая версия не меняется', () => {
  const cur = migrateRun(v1);
  assert.deepEqual(migrateRun(cur), cur);
});

test('migrateRun: файл более новой версии не читается молча', () => {
  assert.throws(() => migrateRun({ version: RUN_VERSION + 1 } as never), /более новой версией/);
});
