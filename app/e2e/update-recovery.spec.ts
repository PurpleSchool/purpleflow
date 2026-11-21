import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { PurpleFlowBridge } from '../src/shared/ipc';
import { launch, makeSandbox, quit, type Launched } from './harness';

type AppWindow = { purpleflow: PurpleFlowBridge };

test('неудачная установка обновления оставляет одно работающее ядро', async () => {
  test.skip(process.platform !== 'linux', 'проверяем отказ установки AppImage');
  const box = makeSandbox();
  const appDir = path.join(box.root, 'app');
  const source = path.resolve(__dirname, '..');
  const original = path.join(box.root, 'current.AppImage');
  fs.mkdirSync(appDir);
  fs.copyFileSync(path.join(source, 'package.json'), path.join(appDir, 'package.json'));
  fs.symlinkSync(path.join(source, 'out'), path.join(appDir, 'out'));
  fs.symlinkSync(path.resolve(source, '../core'), path.join(box.root, 'core'));
  fs.writeFileSync(path.join(appDir, 'dev-app-update.yml'), 'provider: generic\nurl: http://127.0.0.1/\nupdaterCacheDirName: m1-test\n');
  fs.writeFileSync(original, 'current fixture');

  const payload = Buffer.from('update fixture');
  const sha = createHash('sha512').update(payload).digest('base64');
  const latest = `version: 99.0.0
files:
  - url: fixture.AppImage
    sha512: ${sha}
    size: ${payload.length}
path: fixture.AppImage
sha512: ${sha}
`;
  const feed = http.createServer((req, res) => {
    const filename = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (/latest.*\.yml$/.test(filename)) res.end(latest);
    else if (filename === '/fixture.AppImage') res.end(payload);
    else res.writeHead(404).end();
  });
  let launched: Launched | undefined;
  try {
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
    const { port } = feed.address() as AddressInfo;
    const l = await launch(
      box,
      { APPIMAGE: original, XDG_CACHE_HOME: path.join(box.root, 'cache'), PURPLEFLOW_UPDATE_URL: `http://127.0.0.1:${port}/` },
      appDir,
    );
    launched = l;
    const pids = () =>
      l.app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .filter((entry) => entry.serviceName === 'PurpleFlow Core' || entry.name === 'PurpleFlow Core')
          .map((entry) => entry.pid),
      );
    const state = () => l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.update.state());
    await expect.poll(async () => (await pids()).length).toBe(1);
    const [originalPid] = await pids();
    await expect.poll(async () => (await state()).kind).toBe('available');
    await l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.update.download());
    await expect.poll(async () => (await state()).kind).toBe('ready');

    // Установщик должен завершиться ошибкой до перемещения или запуска обновления.
    fs.unlinkSync(original);
    await l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.update.install());
    await expect.poll(state).toMatchObject({ kind: 'failed', message: expect.stringMatching(/ENOENT.*unlink/) });
    await expect.poll(pids).not.toContain(originalPid);
    expect(await l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.core.listRuns())).toEqual([]);
    expect(await pids()).toHaveLength(1);
    expect(l.errors).toEqual([]);
  } finally {
    try {
      if (launched) await quit(launched);
    } finally {
      feed.close();
      box.cleanup();
    }
  }
});
