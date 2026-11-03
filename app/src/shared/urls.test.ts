import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalUrl, isSameDocument, isWebUrl } from './urls';

test('isLocalUrl: только http(s) на этой машине', () => {
  for (const u of ['http://localhost:3000/a', 'https://127.0.0.1/', 'http://[::1]:5173/']) assert.ok(isLocalUrl(u), u);
  for (const u of [
    'https://example.com',
    'http://localhost.evil.com/',
    'http://localhost@evil.com/',
    'http://127.0.0.1.nip.io/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'не адрес',
  ])
    assert.ok(!isLocalUrl(u), u);
});

test('isWebUrl: системному браузеру — только http(s)', () => {
  assert.ok(isWebUrl('https://github.com/a'));
  assert.ok(isWebUrl('http://x.test'));
  for (const u of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'smb://host/share', './README.md'])
    assert.ok(!isWebUrl(u), u);
});

test('isSameDocument: якорь и перезагрузка — да, ссылка наружу и другой файл — нет', () => {
  const dev = 'http://localhost:5173/';
  const prod = 'file:///Applications/PurpleFlow.app/out/renderer/index.html';
  assert.ok(isSameDocument(`${dev}#x`, dev));
  assert.ok(isSameDocument(prod, prod));
  assert.ok(!isSameDocument('https://evil.test/', dev));
  assert.ok(!isSameDocument('http://localhost:5173/README.md', dev));
  assert.ok(!isSameDocument('file:///tmp/dropped.html', prod));
  assert.ok(!isSameDocument('не адрес', dev));
});
