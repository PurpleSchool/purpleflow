// Сквозные сценарии: настоящее окно, настоящее ядро и git, фейковый только claude.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;

test.beforeEach(async () => {
  box = makeSandbox();
  l = await launch(box);
});

test.afterEach(async () => {
  const errors = l.errors;
  await quit(l);
  box.cleanup();
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});

async function startRun(page: Page, mode: string, task: string) {
  await page.getByRole('button', { name: /Выберите проект/ }).click();
  await page.getByRole('menuitem', { name: /Новый проект/ }).click();
  await expect(page.getByRole('button', { name: /demo/ }).first()).toBeVisible();
  await page.getByRole('radio', { name: mode, exact: true }).click();
  await page.locator('#task').fill(task);
  await page.getByRole('button', { name: 'Запустить прогон' }).click();
}

const accept = (page: Page, name: string | RegExp = /^Принять/) => page.getByRole('button', { name });

/** Ветка прогона и файл в ней: результат должен оказаться в git, а не только в окне. */
function resultOnBranch() {
  const branch = box.git('branch', '--list', 'purpleflow/*', '--format=%(refname:short)');
  expect(branch).not.toBe('');
  return { branch, math: box.git('show', `${branch}:src/math.js`) };
}

test('быстрая правка: от задачи до коммита в ветке, рабочая копия не тронута', async () => {
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await accept(l.page).click();
  await expect.poll(() => box.git('branch', '--list', 'purpleflow/*', '--format=%(refname:short)')).not.toBe('');
  await expect.poll(() => resultOnBranch().math).toContain('mul');
  expect(fs.readFileSync(path.join(box.repo, 'src/math.js'), 'utf8')).not.toContain('mul');
  expect(box.git('status', '--porcelain')).toBe('');
  expect(box.calls().some((c) => c.prompt.includes('Добавь функцию mul'))).toBe(true);
});

test('задача с планом: утверждение плана, реализация, ревью, приёмка', async () => {
  await startRun(l.page, 'Задача', 'Добавь умножение в калькулятор');
  await accept(l.page, /^Принять план/).click();
  await accept(l.page).click();
  await expect.poll(() => resultOnBranch().math).toContain('mul');
  const prompts = box.calls().map((c) => c.prompt);
  expect(prompts.some((p) => /ревьюер в конвейере PurpleFlow/.test(p))).toBe(true);
});

test('агент упал: причина видна в окне, прогон не висит', async () => {
  await startRun(l.page, 'Быстрая правка', 'СЛОМАЙ_АГЕНТА в src/math.js');
  await expect(l.page.getByText(/квота исчерпана/).first()).toBeVisible({ timeout: 60_000 });
});

test('перезапуск на приёмке: прогон на месте, принять можно после запуска', async () => {
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await expect(accept(l.page)).toBeVisible({ timeout: 60_000 });
  await quit(l);
  l = await launch(box);
  await l.page.getByText('Добавь функцию mul', { exact: false }).first().click();
  await accept(l.page).click();
  await expect.poll(() => resultOnBranch().math).toContain('mul');
});

test('приёмка: дифф показывает изменение, возврат с него не роняет страницу', async () => {
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  // На приёмке дифф открывается сам.
  await expect(l.page.getByRole('button', { name: 'math.js' })).toBeVisible({ timeout: 60_000 });
  await expect(l.page.locator('.monaco-diff-editor').getByText('mul', { exact: false }).first()).toBeVisible();
  await l.page.getByRole('tab', { name: 'Таймлайн' }).click();
  await expect(l.page.locator('.monaco-diff-editor')).toHaveCount(0);
  await l.page.getByRole('tab', { name: /^Код/ }).first().click();
  await expect(l.page.locator('.monaco-diff-editor').getByText('mul', { exact: false }).first()).toBeVisible();
});

test('менеджер прогона отвечает на вопрос', async () => {
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await expect(accept(l.page)).toBeVisible({ timeout: 60_000 });
  await l.page.getByRole('button', { name: 'Как идут дела?' }).click();
  await expect(l.page.getByText('Всё идёт по плану.').first()).toBeVisible({ timeout: 60_000 });
});

test('запуск: инструменты найдены, настройки открываются', async () => {
  await expect(l.page.getByTitle(/bin\/claude 2\.0\.0/)).toBeVisible();
  await l.page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(l.page.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
});
