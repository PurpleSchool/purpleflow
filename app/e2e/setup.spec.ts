// Первый запуск: окно настройки после экрана входа. Настоящую установку не запускаем: сломанный путь останавливает её до npm.
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;

async function start(settings: Record<string, unknown>) {
  box = makeSandbox({ settings: { onboarded: false, ...settings } });
  l = await launch(box);
}

test.afterEach(async () => {
  const errors = l.errors;
  await quit(l);
  box.cleanup();
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});

test('после пропуска входа открывается окно настройки, а «Готово» ведёт к первому проекту и задаче', async () => {
  await start({ authPrompted: false });
  await l.page.getByRole('button', { name: 'Пропустить' }).click();

  const dialog = l.page.getByRole('dialog', { name: 'Подготовим окружение' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Node.js', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Готово, к задаче' }).click();
  await expect(dialog).toBeHidden();

  // Проектов ещё нет — онбординг первого проекта. Системный выбор папки подменяем папкой песочницы.
  await expect(l.page.getByRole('heading', { name: 'Первый проект' })).toBeVisible();
  await l.app.evaluate(({ dialog: d }, repo) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [repo] })) as typeof d.showOpenDialog;
  }, box.repo);
  await l.page.getByRole('button', { name: 'Выбрать папку…' }).click();
  await expect(l.page.getByText('demo', { exact: true })).toBeVisible();
  await l.page.getByRole('button', { name: 'Быстрое подключение' }).click();

  await expect(l.page.locator('#task')).toBeVisible();
  await expect(l.page.locator('.project-pick').getByText('demo', { exact: true })).toBeVisible();
});

test('«Настроить» показывает причину сбоя, а «Позже» оставляет вкладку «Инструменты»', async () => {
  await start({
    authPrompted: true,
    agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
    toolPaths: { codex: '/нет/такого/codex' },
  });

  const dialog = l.page.getByRole('dialog', { name: 'Подготовим окружение' });
  await dialog.getByRole('button', { name: 'Настроить' }).click();
  await expect(dialog.getByText(/Указан путь вручную/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Повторить' })).toBeEnabled();

  await dialog.getByRole('button', { name: 'Позже' }).click();
  await expect(dialog).toBeHidden();
  await expect(l.page.getByRole('heading', { name: 'Инструменты' })).toBeVisible();
  await expect(l.page.getByRole('button', { name: 'Настроить' })).toBeVisible();
});

test('пока проектов нет, «Как начать?» в меню открывает онбординг первого проекта', async () => {
  await start({ onboarded: true });
  const startBtn = l.page.getByRole('button', { name: 'Как начать?' });
  await startBtn.click();
  await expect(l.page.getByRole('heading', { name: 'Первый проект' })).toBeVisible();
  await expect(l.page.locator('.side')).toHaveCount(0);

  await l.page.getByRole('button', { name: /Пропустить/ }).click();
  await expect(l.page.locator('#task')).toBeVisible();
  await expect(startBtn).toBeVisible();
});
