// Главный экран: две большие карточки — «Создать задачу» и «Новый чат»; логотип возвращает сюда.
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

test('главный экран: «Создать задачу» и «Новый чат», логотип возвращает на главный', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await expect(page.getByRole('heading', { name: 'Что делаем?' })).toBeVisible();
    const task = page.getByRole('button', { name: /^Создать задачу/ });
    const chat = page.getByRole('button', { name: /^Новый чат/ });
    await expect(task).toBeVisible();
    await expect(chat).toBeVisible();
    // Карточки появляются с анимацией — меряем после неё. Карточки квадратные.
    await page.waitForTimeout(700);
    const b = (await task.boundingBox())!;
    expect(Math.abs(b.width - b.height)).toBeLessThan(2);
    // Заголовки карточек на одной высоте, хоть описания и разной длины.
    const ty = async (kind: string) => (await page.locator(`.home-card.is-${kind} strong`).boundingBox())!.y;
    expect(Math.abs((await ty('task')) - (await ty('chat')))).toBeLessThan(1);
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-home.png') });
    }

    await task.click();
    await expect(page.locator('#task')).toBeVisible();
    await page.getByRole('button', { name: 'Главная' }).click();
    await expect(page.getByRole('heading', { name: 'Что делаем?' })).toBeVisible();

    await chat.click();
    await expect(page.locator('.chat-compose textarea')).toBeVisible();
    await page.locator('.chat-compose textarea').fill('Как устроен этот проект?');
    await page.locator('.chat-compose textarea').press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible({ timeout: 30_000 });
    // Пока модель придумывает название — заглушка в истории и в шапке чата, потом название.
    const history = page.getByRole('navigation', { name: 'История' });
    await expect(history.getByRole('status', { name: 'Придумываю название' })).toBeVisible();
    await expect(page.locator('.chat-head').getByRole('status', { name: 'Придумываю название' })).toBeVisible();
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-title-skel.png') });
    await expect(history.getByText('Как устроен этот проект?')).toBeVisible();
    await expect(page.getByLabel('Название чата')).toHaveValue('Как устроен этот проект?');
    // «Продолжить» на главном — этот чат, клик открывает его.
    await page.getByRole('button', { name: 'Главная' }).click();
    const recent = page.getByRole('region', { name: 'Продолжить' });
    await expect(recent.getByRole('button', { name: /Как устроен этот проект\?/ })).toBeVisible();
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-home-recent.png') });
    }
    await recent.getByRole('button', { name: /Как устроен этот проект\?/ }).click();
    await expect(page.locator('.chat-msg.is-user')).toContainText('Как устроен этот проект?');
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('свёрнутая панель: колонка иконок, каждая кнопка ведёт на свой экран', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: /^Скрыть панель/ }).click();
    const rail = page.getByRole('navigation', { name: 'Панель' });
    await expect(rail).toBeVisible();
    // Колонка, а не строка: кнопки друг под другом и все в окне.
    const btns = rail.getByRole('button');
    const first = (await btns.first().boundingBox())!;
    const second = (await btns.nth(1).boundingBox())!;
    expect(second.y).toBeGreaterThan(first.y);
    expect(Math.abs(second.x - first.x)).toBeLessThan(2);
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-rail.png') });
    }
    await rail.getByRole('button', { name: 'Проекты' }).click();
    await expect(page.getByRole('button', { name: 'Новый проект', exact: true }).first()).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Проекты' })).toHaveClass(/is-on/);
    await rail.getByRole('button', { name: 'Новый чат' }).click();
    await expect(page.locator('.chat-compose textarea')).toBeVisible();
    await rail.getByRole('button', { name: 'Новая задача' }).click();
    await expect(page.locator('#task')).toBeVisible();
    await rail.getByRole('button', { name: 'Настройки' }).click();
    await expect(page.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
    await rail.getByRole('button', { name: 'Главная' }).click();
    await expect(page.getByRole('heading', { name: 'Что делаем?' })).toBeVisible();
    // Развернуть обратно.
    await rail.getByRole('button', { name: /^Показать панель/ }).click();
    await expect(page.getByRole('navigation', { name: 'История' })).toBeVisible();
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});
