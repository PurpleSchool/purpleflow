// Мелкие чистые утилиты ядра: JSON из ответа агента, порты, размеры данных, журнал.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isImageFile, isInside, readSmallText } from './files.js';
import { formatItem, originTag } from './items.js';
import { parseJsonReply } from './json.js';
import { TEST_FILE } from './modes.js';
import { expandPorts, freePort, portEnv, waitForUrl } from './net.js';
import { browserLeftovers, screenshots, sizeOf, sizeOfAll, subdirs } from './storage.js';
import { setTraceFile, trace, traced } from './trace.js';
import type { ReviewItem } from './types.js';

const tmpDir = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-util-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('parseJsonReply: чистый JSON, блок кода, JSON в тексте', () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('Вот ответ:\n```json\n{"a":2}\n```\nГотово.'), { a: 2 });
  assert.deepEqual(parseJsonReply('```\n{"a":3}\n```'), { a: 3 });
  assert.deepEqual(parseJsonReply('Итог: {"a":{"b":4}} — всё.'), { a: { b: 4 } });
});

test('parseJsonReply: не объект и не JSON — null', () => {
  assert.equal(parseJsonReply('просто текст'), null);
  assert.equal(parseJsonReply('[1,2]'), null);
  assert.equal(parseJsonReply('null'), null);
  assert.equal(parseJsonReply('{ битый'), null);
  assert.equal(parseJsonReply(''), null);
});

test('TEST_FILE: файлы тестов разных языков, обычный код — нет', () => {
  for (const f of [
    'a.test.ts',
    'src/a.spec.tsx',
    'tests/x.py',
    'pkg/__tests__/a.js',
    'x_test.go',
    'test_a.py',
    'a/test_b.py',
    'b.test.mjs',
  ])
    assert.ok(TEST_FILE.test(f), f);
  for (const f of ['src/latest.ts', 'contest/a.ts', 'testing.ts', 'attest_x.py', 'specs.ts']) assert.ok(!TEST_FILE.test(f), f);
});

test('formatItem и originTag', () => {
  const item = (p: Partial<ReviewItem>) => ({ message: 'текст', ...p }) as ReviewItem;
  assert.equal(formatItem(item({})), 'текст');
  assert.equal(formatItem(item({ file: 'a.ts' })), 'a.ts — текст');
  assert.equal(formatItem(item({ file: 'a.ts', line: 3 })), 'a.ts:3 — текст');
  assert.equal(formatItem(item({ file: 'a.ts', line: 3 }), true), '`a.ts:3` — текст');
  assert.equal(originTag(item({})), '');
  assert.match(originTag(item({ origin: 'unfixed' })), /не исправлено/);
  assert.match(originTag(item({ origin: 'from_fix' })), /из‑за исправления/);
});

test('portEnv: PORT только когда порт не передан в команде явно', () => {
  assert.deepEqual(portEnv('npm run dev', 3000), { PORT: '3000' });
  assert.deepEqual(portEnv('vite --port {port}', 3000), {});
  assert.deepEqual(portEnv('api --port {port:api}', 3000), {});
});

test('expandPorts: {port} и {port:имя} — разные свободные порты, одно имя — один порт', async () => {
  const r = await expandPorts('http://localhost:{port}/?api={port:api}', 'web -p {port} & api -p {port:api} & w -p {port:worker}');
  const api = r.url.match(/api=(\d+)/)?.[1];
  assert.equal(r.url, `http://localhost:${r.port}/?api=${api}`);
  const worker = r.command.match(/w -p (\d+)/)?.[1];
  assert.equal(r.command, `web -p ${r.port} & api -p ${api} & w -p ${worker}`);
  assert.equal(new Set([String(r.port), api, worker]).size, 3);
  const plain = await expandPorts('http://example.test', 'run');
  assert.equal(plain.url, 'http://example.test');
  assert.equal(plain.command, 'run');
});

test('waitForUrl: ответ любого кода — готово; отмена и таймаут — нет', async (t) => {
  const srv = http.createServer((_, res) => {
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const up = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  assert.equal(await waitForUrl(up, 5000, () => false), true);
  assert.equal(await waitForUrl(up, 5000, () => true), false);
  const down = `http://127.0.0.1:${await freePort()}/`;
  assert.equal(await waitForUrl(down, 300, () => false), false);
});

test('sizeOf и subdirs: файлы и каталоги, несуществующий путь — ноль', async (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a/b/f.bin'), Buffer.alloc(8192));
  fs.writeFileSync(path.join(dir, 'g.bin'), Buffer.alloc(8192));
  assert.equal(await sizeOf(path.join(dir, 'нет')), 0);
  assert.ok((await sizeOf(path.join(dir, 'g.bin'))) >= 8192);
  const a = await sizeOf(path.join(dir, 'a'));
  assert.ok(a >= 8192);
  assert.ok((await sizeOfAll([path.join(dir, 'a'), path.join(dir, 'g.bin')])) > a);
  assert.deepEqual(subdirs(dir), [path.join(dir, 'a')]);
  assert.deepEqual(subdirs(path.join(dir, 'нет')), []);
});

test('browserLeftovers и screenshots: служебное браузера отдельно от снимков', (t) => {
  const root = tmpDir(t);
  const attempt = path.join(root, 'run1', '1');
  fs.mkdirSync(path.join(attempt, 'chrome-profile'), { recursive: true });
  fs.mkdirSync(path.join(attempt, '.playwright-cli'));
  for (const f of ['a.png', 'b.JPG', 'c.webp', 'notes.md']) fs.writeFileSync(path.join(attempt, f), '');
  assert.deepEqual(browserLeftovers(root).sort(), [path.join(attempt, '.playwright-cli'), path.join(attempt, 'chrome-profile')]);
  assert.deepEqual(
    screenshots(root)
      .map((p) => path.basename(p))
      .sort(),
    ['a.png', 'b.JPG', 'c.webp'],
  );
  assert.deepEqual(screenshots(path.join(root, 'нет')), []);
});

test('files: картинка по расширению; текст — только небольшой и в UTF-8', (t) => {
  const dir = tmpDir(t);
  assert.ok(isImageFile('A.PNG'));
  assert.ok(!isImageFile('a.svg'));
  const p = (n: string, c: string | Buffer) => {
    fs.writeFileSync(path.join(dir, n), c);
    return path.join(dir, n);
  };
  assert.equal(readSmallText(p('t.txt', 'привет')), 'привет');
  assert.equal(readSmallText(p('big.txt', 'x'.repeat(20)), 10), null);
  assert.equal(readSmallText(p('nul.bin', Buffer.from([65, 0, 66]))), null);
  assert.equal(readSmallText(p('latin.txt', Buffer.from([0xff, 0xfe, 0x41]))), null);
  assert.equal(readSmallText(path.join(dir, 'нет')), null);
});

test('trace: пишет в журнал, большой журнал обрезается по границе строки, traced гасит ошибку', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'core.log');
  t.after(() => setTraceFile(null));
  setTraceFile(file);
  trace('scope', new Error('многострочная\nошибка'));
  assert.match(fs.readFileSync(file, 'utf8'), /\[scope\] многострочная ошибка\n$/);
  assert.equal(traced('bg')('сбой'), undefined);
  assert.match(fs.readFileSync(file, 'utf8'), /\[bg\] сбой\n$/);

  fs.writeFileSync(file, `${'старая строка\n'.repeat(100_000)}`);
  trace('new', 'свежая');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.length < 600_000);
  assert.ok(after.startsWith('старая строка\n'), 'первая строка целая');
  assert.match(after, /\[new\] свежая\n$/);
});

test('isInside: только настоящие потомки каталога', () => {
  assert.ok(isInside('/data/worktrees', '/data/worktrees/a'));
  assert.ok(isInside('/data/worktrees', '/data/worktrees/a/b'));
  assert.ok(!isInside('/data/worktrees', '/data/worktrees'));
  assert.ok(!isInside('/data/worktrees', '/data/worktrees-x/a'));
  assert.ok(!isInside('/data/worktrees', '/data/worktrees/../secret'));
  assert.ok(!isInside('/data/worktrees', '/home/me'));
});
