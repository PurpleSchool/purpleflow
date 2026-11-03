// Скриншоты для README: npm run screenshots -w @purpleflow/app. Настоящее окно, задача-пример и фейковый агент.
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

const OUT = path.join(__dirname, '../../docs/screenshots');

test('скриншоты для README', async () => {
  test.skip(!process.env.PURPLEFLOW_SHOTS, 'только по npm run screenshots');
  test.setTimeout(180_000);
  // Короткий путь: он виден в шапке прогона.
  const box = makeSandbox({ tmpRoot: '/tmp', delayMs: 2500 });
  const l = await launch(box, { PURPLEFLOW_WIN: '1440x900' });
  const { page } = l;
  // Окно на macOS прозрачное: без подложки снимок полупрозрачен и белеет на светлом фоне GitHub.
  await page.addStyleTag({ content: 'html { background: #0a0b0d; }' });
  const shot = async (name: string) => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  try {
    await page.getByRole('button', { name: /Выберите проект/ }).click();
    await page.getByRole('menuitem', { name: /Новый проект/ }).click();
    await page.locator('#task').fill('Добавь функцию slugify(s) в src/slugify.js: транслитерация с русского в kebab-case, и тесты к ней');
    await expect(page.getByRole('button', { name: /demo/ }).first()).toBeVisible();
    await shot('new-task');

    await page.getByRole('button', { name: 'Запустить прогон' }).click();
    await expect(page.getByRole('button', { name: /^Принять план/ })).toBeVisible({ timeout: 90_000 });
    await shot('gate1-plan');

    await page.getByRole('button', { name: /^Принять план/ }).click();
    await expect(page.getByRole('button', { name: /^Принять/ })).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible();
    await shot('gate2-accept');

    await page.getByRole('button', { name: /^Принять/ }).click();
    await expect(page.getByText('Готов', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await page.getByRole('tab', { name: 'Таймлайн' }).click();
    await shot('run-timeline');

    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await shot('settings');
  } finally {
    await quit(l);
    box.cleanup();
  }
});
