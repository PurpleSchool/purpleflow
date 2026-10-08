import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorCount, failedTestNames, portEnv } from './orchestrator.js';

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

test('failedTestNames: Jest — имена из «●», без дублей и Console', () => {
  const out = [
    ' FAIL  test/carousel.e2e-spec.ts',
    '  ● Carousel (e2e) › POST /slide/:index/image › отклоняет загрузку',
    '  ● Console',
    'Summary of all failing tests',
    ' FAIL  ./carousel.e2e-spec.ts',
    '\x1b[1m  ● Carousel (e2e) › POST /slide/:index/image › отклоняет загрузку\x1b[22m',
    'Tests:       1 failed, 520 passed, 521 total',
  ].join('\n');
  assert.deepEqual(failedTestNames(out), ['Carousel (e2e) › POST /slide/:index/image › отклоняет загрузку']);
});

test('failedTestNames: Vitest, pytest, go, node:test; нераспознанный вывод — null', () => {
  assert.deepEqual(failedTestNames(' FAIL  src/a.test.ts > sum > adds 12ms\n × src/b.test.ts > x > y'), ['src/a.test.ts > sum > adds', 'src/b.test.ts > x > y']);
  assert.deepEqual(failedTestNames('FAILED tests/test_a.py::test_one - assert 1 == 2'), ['tests/test_a.py::test_one']);
  assert.deepEqual(failedTestNames('--- FAIL: TestSum (0.00s)'), ['TestSum']);
  assert.deepEqual(failedTestNames('not ok 3 - padLeft keeps width'), ['padLeft keeps width']);
  assert.equal(failedTestNames('Error: something broke'), null);
});

test('portEnv: PORT только если в команде запуска нет {port}', () => {
  assert.deepEqual(portEnv('npm run dev', 5173), { PORT: '5173' });
  assert.deepEqual(portEnv('(cd api && npm run start:dev) & (cd web && next dev -p {port})', 5173), {});
  assert.deepEqual(portEnv('vite --port {port:web}', 5173), {});
});

test('packReview: код раньше текстов, большой файл урезан, крупный дифф — на части по модулям', async () => {
  const { packReview, priorityOf } = await import('./reviewdiff.js');
  const file = (p: string, n: number) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${'+x\n'.repeat(n)}`;
  assert.equal(priorityOf('src/a.ts', 100), 0);
  assert.equal(priorityOf('test/a.e2e-spec.ts', 100), 1);
  assert.equal(priorityOf('src/prompts/big.prompt.ts', 50_000), 3);
  assert.equal(priorityOf('README.md', 100), 3);
  const one = packReview(file('README.md', 10) + file('src/svc.ts', 10), 10_000);
  assert.equal(one.parts.length, 1);
  assert.ok(one.parts[0].indexOf('src/svc.ts') < one.parts[0].indexOf('README.md'));
  const big = packReview(file('src/prompts/huge.prompt.ts', 20_000), 100_000);
  assert.deepEqual(big.trimmed, ['src/prompts/huge.prompt.ts']);
  const many = packReview(file('packages/api/src/a.ts', 3000) + file('packages/web/src/b.ts', 3000) + file('packages/api/src/c.ts', 3000), 20_000);
  assert.equal(many.parts.length, 2);
  assert.ok(many.files.some((f) => f.includes('packages/api/src/a.ts') && f.includes('packages/api/src/c.ts')));
  assert.deepEqual(many.omitted, []);
});

test('parseVerdicts и ARTIFACT_RE', async () => {
  const { parseVerdicts } = await import('./orchestrator.js');
  const { ARTIFACT_RE } = await import('./reviewdiff.js');
  assert.deepEqual(parseVerdicts('ok {"items":[{"index":1,"verdict":"rejected","reason":"есть проверка"},{"index":2,"verdict":"bogus","reason":""}]}'), [{ index: 1, verdict: 'rejected', reason: 'есть проверка' }]);
  assert.equal(parseVerdicts('не JSON'), null);
  for (const f of ['packages/frontend/tsconfig.tsbuildinfo', 'apps/web/next-env.d.ts', '.DS_Store', 'npm-debug.log.123']) assert.ok(ARTIFACT_RE.test(f), f);
  for (const f of ['src/next-env.ts', 'package-lock.json', 'src/app.ts']) assert.ok(!ARTIFACT_RE.test(f), f);
});
