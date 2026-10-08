import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorCount } from './orchestrator.js';

test('errorCount: ESLint, суммирует несколько пакетов монорепо', () => {
  const out = 'apps/web ...\n✖ 3 problems (2 errors, 1 warning)\n\napps/api ...\n\x1b[31m✖ 191 problems (191 errors, 0 warnings)\x1b[39m';
  assert.equal(errorCount(out), 193);
});

test('errorCount: tsc, Jest, node:test, pytest, mocha', () => {
  assert.equal(errorCount('src/a.ts(1,1): error TS2322\nFound 4 errors in 2 files.'), 4);
  assert.equal(errorCount('Tests:       2 failed, 40 passed, 42 total'), 2);
  assert.equal(errorCount('ℹ tests 12\nℹ pass 11\nℹ fail 1'), 1);
  assert.equal(errorCount('=== 3 failed, 10 passed in 1.2s ==='), 3);
  assert.equal(errorCount('  5 passing\n  2 failing'), 2);
});

test('errorCount: нераспознанный вывод — по строкам с error, иначе null', () => {
  assert.equal(errorCount('Error: boom\nerror again\nok'), 2);
  assert.equal(errorCount('всё сломалось'), null);
});

test('explainError: base64 картинки не попадает в сообщение', async () => {
  const { explainError } = await import('./agents/common.js');
  const b64 = 'iVBORw0KGgo'.padEnd(400, 'A');
  assert.equal(explainError('claude', `Request too large\n${b64}`), 'claude: Request too large');
});

test('parseQuestions: JSON с вопросами, не больше 4, пустой — без вопросов', async () => {
  const { parseQuestions } = await import('./orchestrator.js');
  const qs = parseQuestions('ок\n{"questions":[{"q":"Где показывать?","options":["Шапка","Сайдбар"],"why":"Меняет компонент"},{"q":"x"}]}');
  assert.equal(qs.length, 1);
  assert.deepEqual(qs[0].options, ['Шапка', 'Сайдбар']);
  assert.deepEqual(parseQuestions('{"questions":[]}'), []);
  assert.deepEqual(parseQuestions('нет json'), []);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isImageFile, readSmallText } from './orchestrator.js';

test('вложения: изображения и небольшие текстовые файлы', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psflow-att-'));
  const txt = path.join(dir, 'spec.md');
  const bin = path.join(dir, 'data.bin');
  const big = path.join(dir, 'big.log');
  fs.writeFileSync(txt, '# Требования\nфункция padLeft');
  fs.writeFileSync(bin, Buffer.from([1, 0, 2, 3]));
  fs.writeFileSync(big, 'x'.repeat(20_000));
  assert.equal(isImageFile('a/b/Shot.PNG'), true);
  assert.equal(isImageFile('a/spec.pdf'), false);
  assert.equal(readSmallText(txt), '# Требования\nфункция padLeft');
  assert.equal(readSmallText(bin), null);
  assert.equal(readSmallText(big), null);
});
