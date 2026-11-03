// Автообновление: настоящий electron-updater читает ленту с локального сервера, дальше — состояния из main.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;
let feed: http.Server;
let requested: string[];

const LATEST = `version: 99.0.0
files:
  - url: PurpleFlow-99.0.0.zip
    sha512: AAAA
    size: 1
path: PurpleFlow-99.0.0.zip
sha512: AAAA
releaseDate: '2026-11-03T00:00:00.000Z'
`;

test.beforeEach(async () => {
  requested = [];
  feed = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    if (/latest.*\.yml/.test(req.url ?? '')) res.end(LATEST);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
  box = makeSandbox();
  l = await launch(box, { PURPLEFLOW_UPDATE_URL: `http://127.0.0.1:${(feed.address() as AddressInfo).port}/` });
});

test.afterEach(async () => {
  const errors = l.errors;
  await quit(l);
  feed.close();
  box.cleanup();
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});

const offer = () => l.page.getByRole('status', { name: 'Обновление' });

/** Последние шаги зависят от подписи и ОС, поэтому их состояние передаём так же, как это делает main. */
const pushState = (state: object) =>
  l.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('update:state', s), state);

test('новая версия в ленте: окно предлагает обновиться, «Позже» убирает предложение', async () => {
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  expect(requested.some((u) => /latest.*\.yml/.test(u))).toBe(true);
  await offer().getByRole('button', { name: 'Позже' }).click();
  await expect(offer()).toHaveCount(0);
});

test('готовое обновление предлагает перезапуск, сбой — ручную загрузку', async () => {
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  await pushState({ kind: 'ready', version: '99.0.0' });
  await expect(offer().getByRole('button', { name: 'Перезапустить' })).toBeVisible();
  await pushState({ kind: 'failed', version: '99.0.0', message: 'Code signature did not pass validation' });
  await expect(offer()).toContainText('Code signature');
  await expect(offer().getByRole('link', { name: 'Скачать вручную' })).toHaveAttribute('href', /releases\/latest/);
});
