// Установка своего Node.js: настоящие загрузка с локального сервера, tar и запуск; вместо сборки Node — сценарии.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectNode, installNode, nodeDist } from './services/node.js';

const skip = process.platform === 'win32';

/** Архив как у nodejs.org: один каталог верхнего уровня, внутри bin/node и bin/npm. */
async function sandbox(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-node-')));
  const home = process.env.HOME;
  process.env.HOME = root;
  const bin = path.join(root, 'src', 'node-v0', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v9.9.9\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const archive = path.join(root, 'node.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'src'), 'node-v0']);
  const data = fs.readFileSync(archive);
  const server = http.createServer((req, res) => (req.url === '/node.tar.gz' ? res.end(data) : res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    process.env.HOME = home;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/node.tar.gz`,
    sha256: createHash('sha256').update(data).digest('hex'),
    env: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
  };
}

test('nodeDist: есть сборка для всех поддерживаемых систем, для прочих — нет', () => {
  for (const [platform, arch, ending] of [
    ['darwin', 'arm64', 'darwin-arm64.tar.gz'],
    ['darwin', 'x64', 'darwin-x64.tar.gz'],
    ['linux', 'x64', 'linux-x64.tar.gz'],
    ['linux', 'arm64', 'linux-arm64.tar.gz'],
    ['win32', 'x64', 'win-x64.zip'],
    ['win32', 'arm64', 'win-arm64.zip'],
  ]) {
    const d = nodeDist(platform, arch);
    assert.ok(d?.url.startsWith('https://nodejs.org/dist/') && d.url.endsWith(ending), `${platform}-${arch}`);
    assert.match(d?.sha256 ?? '', /^[0-9a-f]{64}$/);
  }
  assert.equal(nodeDist('freebsd', 'x64'), null);
});

test('installNode: распаковывает в свою папку, и новый Node находится сразу', { skip }, async (t) => {
  const s = await sandbox(t);
  assert.equal((await detectNode({ PATH: path.join(s.root, 'нет') })).path, null);
  const r = await installNode(s.env, { url: s.url, sha256: s.sha256 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info?.path, path.join(s.root, '.purpleflow', 'node', 'bin', 'node'));
  assert.equal(r.info?.version, '9.9.9');
  assert.deepEqual(fs.readdirSync(path.join(s.root, '.purpleflow')), ['node'], 'временные каталоги не остаются');
});

test('installNode: чужая контрольная сумма — ничего не ставит', { skip }, async (t) => {
  const s = await sandbox(t);
  const r = await installNode(s.env, { url: s.url, sha256: '0'.repeat(64) });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Контрольная сумма/);
  assert.deepEqual(fs.readdirSync(path.join(s.root, '.purpleflow')), []);
  assert.equal(s.env.PATH, '/usr/bin:/bin');
});

test('installNode: сбой загрузки не трогает уже стоящий Node', { skip }, async (t) => {
  const s = await sandbox(t);
  await installNode(s.env, { url: s.url, sha256: s.sha256 });
  const r = await installNode(s.env, { url: `${s.url}.missing`, sha256: s.sha256 });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /HTTP 404/);
  assert.ok(fs.existsSync(path.join(s.root, '.purpleflow', 'node', 'bin', 'node')));
});

test('installNode: для неизвестной системы просит поставить вручную', async () => {
  const r = await installNode({ PATH: '' }, null);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /nodejs\.org/);
});
