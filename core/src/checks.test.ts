import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portEnv } from './net.js';
import { errorCount, failedTestNames, parseReview } from './parse.js';
import { lineStats } from './reviewdiff.js';
import { compareWithBase, startNextPhase } from './stages/checks.js';
import type { Kernel } from './kernel.js';
import type { RunFile, TestResult } from './types.js';

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
  const { parseQuestions } = await import('./parse.js');
  const qs = parseQuestions('ок\n{"questions":[{"q":"Где показывать?","options":["Шапка","Сайдбар"],"why":"Меняет компонент"},{"q":"x"}]}');
  assert.equal(qs.length, 1);
  assert.deepEqual(qs[0].options, ['Шапка', 'Сайдбар']);
  assert.deepEqual(parseQuestions('{"questions":[]}'), []);
  assert.deepEqual(parseQuestions('нет json'), []);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isImageFile, readSmallText } from './files.js';

test('вложения: изображения и небольшие текстовые файлы', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-att-'));
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
  assert.deepEqual(failedTestNames(' FAIL  src/a.test.ts > sum > adds 12ms\n × src/b.test.ts > x > y'), [
    'src/a.test.ts > sum > adds',
    'src/b.test.ts > x > y',
  ]);
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
  const many = packReview(
    file('packages/api/src/a.ts', 3000) + file('packages/web/src/b.ts', 3000) + file('packages/api/src/c.ts', 3000),
    20_000,
  );
  assert.equal(many.parts.length, 2);
  assert.ok(many.files.some((f) => f.includes('packages/api/src/a.ts') && f.includes('packages/api/src/c.ts')));
  assert.deepEqual(many.omitted, []);
});

test('parseVerdicts и ARTIFACT_RE', async () => {
  const { parseVerdicts } = await import('./parse.js');
  const { ARTIFACT_RE } = await import('./reviewdiff.js');
  assert.deepEqual(
    parseVerdicts('ok {"items":[{"index":1,"verdict":"rejected","reason":"есть проверка"},{"index":2,"verdict":"bogus","reason":""}]}'),
    [{ index: 1, verdict: 'rejected', reason: 'есть проверка' }],
  );
  assert.equal(parseVerdicts('не JSON'), null);
  for (const f of ['packages/frontend/tsconfig.tsbuildinfo', 'apps/web/next-env.d.ts', '.DS_Store', 'npm-debug.log.123'])
    assert.ok(ARTIFACT_RE.test(f), f);
  for (const f of ['src/next-env.ts', 'package-lock.json', 'src/app.ts']) assert.ok(!ARTIFACT_RE.test(f), f);
});

test('parseNextParts: пункты раздела до следующего заголовка', async () => {
  const { parseNextParts } = await import('./parse.js');
  const p = '# Т\n\n## Why\nx\n\n## Next Parts\n- Часть 2: озвучка\n  и дубли голоса\n2. Часть 3: сцены\n\n## Invariants\n- не трогать\n';
  assert.deepEqual(parseNextParts(p), ['Часть 2: озвучка и дубли голоса', 'Часть 3: сцены']);
  assert.deepEqual(parseNextParts('# Т\n## Why\nx'), []);
});

test('тесты задачи: команда из «## Checks» proposal.md; «нет» и пустой раздел — не выбраны', async () => {
  const { parseFocusTests } = await import('./parse.js');
  assert.equal(parseFocusTests('# X\n\n## Why\nтекст\n\n## Checks\n- `npx vitest run src/audio`\n'), 'npx vitest run src/audio');
  assert.equal(parseFocusTests('## Checks\n\n- `pytest tests/audio -q`\n\n## Next Parts\n- `другое`\n'), 'pytest tests/audio -q');
  assert.equal(parseFocusTests('## Checks\n- нет\n\n## Next Parts\n- `npm test`\n'), undefined);
  assert.equal(parseFocusTests('## Why\n`npm test`\n'), undefined);
});

const fakeKernel = { log: () => {} } as unknown as Kernel;
const failedCheck = (output: string, command = 't') => ({
  kind: 'test' as const,
  command,
  passed: false,
  exitCode: 1,
  durationMs: 1,
  output,
});
const withBase = (output: string) => ({ baseChecks: [failedCheck(output)] }) as unknown as RunFile;
const resultOf = (output: string) => ({ passed: false, exitCode: 1, checks: [failedCheck(output)] }) as unknown as TestResult;

test('compareWithBase: другой упавший тест при том же счёте — новая поломка', () => {
  const was = 'not ok 1 - старый тест\n# fail 1\n';
  const same = compareWithBase(fakeKernel, withBase(was), resultOf(was));
  assert.equal(same.result.passed, true);
  assert.equal(same.failed.length, 0);
  const other = compareWithBase(fakeKernel, withBase(was), resultOf('not ok 1 - новый тест\n# fail 1\n'));
  assert.equal(other.result.passed, false);
  assert.equal(other.failed.length, 1);
});

test('compareWithBase: имён нет — сравнение по числу ошибок; своего эталона нет — блокирует', () => {
  const run = withBase('Found 2 errors');
  assert.equal(compareWithBase(fakeKernel, run, resultOf('Found 1 error')).result.passed, true);
  assert.equal(compareWithBase(fakeKernel, run, resultOf('Found 3 errors')).result.passed, false);
  assert.equal(compareWithBase(fakeKernel, {} as RunFile, resultOf('Found 1 error')).result.passed, false);
});

test('errorCount: итог Vitest без двоеточия не подменяется подсчётом строк со словом error', () => {
  assert.equal(errorCount('Error: boom\nAssertionError: x\nerror y\n Tests  1 failed | 3 passed (4)\n'), 1);
  assert.equal(errorCount('Tests:       2 failed, 5 passed, 7 total'), 2);
});

test('parseReview: ответ в последнем блоке кода, перед ним пример кода', () => {
  const text = 'Смотри:\n```ts\nconst a = { b: 1 };\n```\nИтог:\n```json\n{"blocking":["x"],"notes":[]}\n```';
  assert.deepEqual(parseReview(text)?.blocking, [{ file: null, line: null, message: 'x' }]);
});

test('lineStats: добавленная строка «++i» считается, заголовки файла — нет', () => {
  const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n--i;\n+++i;\n keep\n';
  assert.deepEqual(lineStats(diff), { add: 1, del: 1 });
});

test('startNextPhase: этапы большой задачи идут по порядку, последний — false', () => {
  const r = {
    mode: 'epic',
    phase: 1,
    phases: 2,
    implAttemptsUsed: 3,
    implAttemptsLimit: 3,
    executorSession: 's',
    next: 'tests',
  } as unknown as RunFile;
  assert.equal(startNextPhase(fakeKernel, r), true);
  assert.equal(r.phase, 2);
  assert.equal(r.next, 'implement');
  assert.equal(r.implAttemptsUsed, 0);
  assert.equal(r.executorSession, undefined);
  assert.equal(startNextPhase(fakeKernel, r), false);
  assert.equal(startNextPhase(fakeKernel, { mode: 'task' } as RunFile), false);
});
