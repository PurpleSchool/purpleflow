import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunStore } from './store.js';

test('RunStore: битый runs.json не теряется молча — копия откладывается рядом', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-'));
  const store = new RunStore(dir);
  const index = 'runs.json';
  fs.writeFileSync(path.join(dir, index), '{ битый');
  assert.deepEqual(store.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(`${index}.broken-`)));
  fs.rmSync(dir, { recursive: true, force: true });
});
