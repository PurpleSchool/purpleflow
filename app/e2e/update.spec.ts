// Автообновление: настоящий electron-updater читает ленту с локального сервера, дальше — состояния из main.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;
let feed: http.Server;
let requested: string[];
let feedBroken: boolean;
let latest: string;

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
  feedBroken = false;
  latest = LATEST;
  feed = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    if (feedBroken) res.writeHead(500).end();
    else if (/latest.*\.yml/.test(req.url ?? '')) res.end(latest);
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

/** Настоящий пункт меню приложения. */
const clickCheckInMenu = () =>
  l.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined =>
      items.flatMap((i) => (i.submenu ? [i, ...i.submenu.items] : [i])).find((i) => i.label === 'Проверить обновления…');
    find(Menu.getApplicationMenu()!.items)!.click();
  });

test('пункт меню проверяет заново и возвращает скрытое предложение', async () => {
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  await offer().getByRole('button', { name: 'Позже' }).click();
  await expect(offer()).toHaveCount(0);
  await clickCheckInMenu();
  await expect(offer()).toContainText('Доступна версия 99.0.0');
});

test('ручная проверка сообщает, что версия последняя, и показывает сбой', async () => {
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  latest = LATEST.replaceAll('99.0.0', '0.0.1');
  await clickCheckInMenu();
  await expect(offer()).toContainText('У вас последняя версия');
  feedBroken = true;
  await clickCheckInMenu();
  await expect(offer()).toContainText('Не удалось проверить обновления');
  await offer().getByRole('button', { name: 'Закрыть' }).click();
  await expect(offer()).toHaveCount(0);
});

test('кнопка в настройках запускает ту же проверку: на Windows и Linux меню не видно', async () => {
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  await offer().getByRole('button', { name: 'Позже' }).click();
  await l.page.getByRole('button', { name: 'Настройки' }).click();
  await l.page.getByRole('tab', { name: 'Приложение' }).click();
  await l.page.getByRole('button', { name: 'Проверить обновления' }).click();
  await expect(offer()).toContainText('Доступна версия 99.0.0');
});

test('плашка наверху и непрозрачная, даже в режиме стекла', async () => {
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  const box = await offer().boundingBox();
  expect(box!.y).toBeLessThan(40);
  const bg = await offer().evaluate((el) => getComputedStyle(el).backgroundColor);
  // Непрозрачный фон всплывающих окон (--pop-bg): rgb без альфы, а не полупрозрачный rgba.
  expect(bg).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
});

test('готовое обновление предлагает перезапуск, сбой — ручную загрузку', async () => {
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  await pushState({ kind: 'ready', version: '99.0.0' });
  await expect(offer().getByRole('button', { name: 'Перезапустить' })).toBeVisible();
  await pushState({ kind: 'failed', version: '99.0.0', message: 'Code signature did not pass validation' });
  await expect(offer()).toContainText('Code signature');
  await expect(offer().getByRole('link', { name: 'Скачать вручную' })).toHaveAttribute('href', /releases\/latest/);
});
