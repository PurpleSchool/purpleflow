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

test('после пропуска входа открывается окно настройки, а «Готово» ведёт к задаче', async () => {
  await start({ authPrompted: false });
  await l.page.getByRole('button', { name: 'Пропустить' }).click();

  const dialog = l.page.getByRole('dialog', { name: 'Подготовим окружение' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Готово, к задаче' }).click();

  await expect(dialog).toBeHidden();
  await expect(l.page.locator('#task')).toBeVisible();
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
