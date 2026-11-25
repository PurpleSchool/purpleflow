import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeLater } from './services/connection.js';

// Удаление, которому мешают права: на Windows так выглядит папка, которую ещё держит процесс агента (EPERM).
test(
  'папка проверки подключения: не удалилась — проверка не падает; удаляется, когда можно',
  { skip: process.platform === 'win32' },
  () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-conn-'));
    const dir = path.join(parent, 'purpleflow-check-x');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'f'), '');
    fs.chmodSync(dir, 0o555);
    try {
      assert.doesNotThrow(() => removeLater(dir, []));
      assert.ok(fs.existsSync(dir));
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    removeLater(dir, []);
    assert.equal(fs.existsSync(dir), false);
    fs.rmSync(parent, { recursive: true, force: true });
  },
);
