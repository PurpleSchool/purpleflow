// Проект из нескольких репозиториев: верхняя папка, галочки участников, прогон с коммитом в каждом.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

test('папка с несколькими репозиториями: собрать проект, прогон правит оба, коммит в каждом', async () => {
  const box = makeSandbox();
  // shop/ — не репозиторий: api и web — копии демо-проекта, docs — не участвует.
  const shop = path.join(box.root, 'shop');
  fs.mkdirSync(shop);
  for (const name of ['api', 'web', 'docs']) execFileSync('git', ['clone', '-q', box.repo, path.join(shop, name)]);
  const l = await launch(box);
  const { page } = l;
  try {
    await l.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, shop);
    await page.getByRole('button', { name: /^Создать задачу/ }).click();
    await page.getByRole('button', { name: /Выберите проект/ }).click();
    await page.getByRole('menuitem', { name: /Новый проект/ }).click();
    await page.getByRole('button', { name: 'Выбрать папку…' }).click();

    const setup = page.locator('.multi-setup');
    await expect(setup).toContainText('В папке 3 репозитория');
    await setup.getByLabel('Участвует: docs').uncheck();
    await expect(setup.getByRole('button', { name: /Создать проект из 2 репозиториев/ })).toBeEnabled();
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-multi-setup.png') });
    }
    await setup.getByRole('button', { name: /Создать проект/ }).click();
    // Мастер: проект собран — подключаем и возвращаемся к задаче.
    await page.getByRole('button', { name: /Быстрое подключение|Подключить и создать задачу/ }).click();
    // Проект открыт по основному репозиторию, но называется по верхней папке.
    await expect(page.getByRole('button', { name: /shop/ }).first()).toBeVisible();
    await expect(page.locator('.multi-setup')).toHaveCount(0);
    await expect(page.getByText(/Отдельные копии всех репозиториев проекта/)).toBeVisible();

    const saved = JSON.parse(fs.readFileSync(path.join(box.profile, 'data', 'projects.json'), 'utf8')) as Record<
      string,
      { multiRepo?: { root: string; repos: string[] }; testCommand: string }
    >;
    const cfg = saved[path.join(shop, 'api')];
    expect(cfg.multiRepo).toEqual({ root: shop, repos: ['web'] });
    expect(cfg.testCommand).toMatch(/^cd api && /);

    await page.getByRole('radio', { name: 'Быстрая правка', exact: true }).click();
    await page.locator('#task').fill('Добавь функцию mul в src/math.js');
    await page.getByRole('button', { name: 'Запустить прогон' }).click();
    await page.getByRole('button', { name: /^Принять/ }).click();

    const inRepo =
      (name: string) =>
      (...a: string[]) =>
        execFileSync('git', a, { cwd: path.join(shop, name), encoding: 'utf8' }).trim();
    const branchOf = (name: string) => inRepo(name)('branch', '--list', 'purpleflow/*', '--format=%(refname:short)');
    await expect.poll(() => branchOf('web')).not.toBe('');
    const branch = branchOf('api');
    expect(branch).toBe(branchOf('web'));
    await expect.poll(() => inRepo('web')('show', `${branch}:src/math.js`)).toContain('mul');
    // Участники коммитятся раньше основного: в run.json основного — их коммиты.
    await expect.poll(() => inRepo('api')('show', `${branch}:src/math.js`)).toContain('mul');
    // Неотмеченный и рабочие папки пользователя не тронуты.
    expect(branchOf('docs')).toBe('');
    expect(fs.readFileSync(path.join(shop, 'web/src/math.js'), 'utf8')).not.toContain('mul');
  } finally {
    await quit(l);
    box.cleanup();
  }
});
