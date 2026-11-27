import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

// Картинки через MCP PurpleSchool: после входа — переключатель и модели в «Аккаунте»; в чате агент подключает сервер
// с ключом аккаунта, а нарисованная картинка видна прямо в ответе.
const EMAIL = 'media@example.com';
const KEY = {
  id: 1,
  name: 'PurpleFlow',
  proxyKey: 'sk-test-media',
  effectiveStatus: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00.000Z',
  lastUsedAt: null,
};
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function fakeApi(seen: { auth: string[]; paid?: boolean }) {
  const token = `h.${Buffer.from(JSON.stringify({ email: EMAIL })).toString('base64url')}.s`;
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
      const json = (data: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      if (route === 'POST /auth/login') return json({ accessToken: token });
      if (route === 'GET /user/profile') return json({ profile: { name: 'Медиа' } });
      if (route === 'GET /public/ai-proxy/api-keys') return json({ items: [KEY], activeKeysLimit: 10 });
      // Подписки нет — в аккаунте предложение её оформить.
      // Купленный пакет — остаток больше пробного бонуса.
      if (route === 'GET /public/ai-proxy/overview')
        return json({
          balance: { remainingUnits: seen.paid ? '900000' : '500000', initialBalanceGrant: { remainingUnits: '500000' } },
          currentPlan: null,
        });
      if (route === 'GET /img/cat.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PIXEL);
      if (route === 'POST /mcp') {
        seen.auth.push(String(req.headers.authorization));
        const m = JSON.parse(body || '{}') as { id?: number; method: string; params?: { name?: string } };
        if (m.method === 'initialize') {
          res.setHeader('Mcp-Session-Id', 'sess-1');
          return json({
            jsonrpc: '2.0',
            id: m.id,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } },
          });
        }
        if (m.method === 'notifications/initialized') return res.writeHead(202).end();
        if (m.method === 'tools/list')
          return json({
            jsonrpc: '2.0',
            id: m.id,
            result: {
              tools: [
                {
                  name: 'generate_image',
                  inputSchema: {
                    properties: { model: { default: 'nano-banana-2.1', enum: ['nano-banana-2.1', 'flux-3-klein', 'gpt-image-2'] } },
                  },
                },
              ],
            },
          });
        if (m.method === 'tools/call' && m.params?.name === 'list_models')
          return json({
            jsonrpc: '2.0',
            id: m.id,
            result: { content: [], structuredContent: { models: [{ id: 'flux-3-klein', prices: { '1K': 6400 } }] } },
          });
      }
      return json({ statusCode: 404, message: 'Not Found' }, 404);
    });
  });
}

test('картинки через MCP PurpleSchool: модели в аккаунте, сервер у агента в чате, картинка в ответе', async () => {
  const seen = { auth: [] as string[], paid: false };
  const api = fakeApi(seen);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const box = makeSandbox({ settings: { enabledAgents: ['claude', 'codex'] } });
  const l = await launch(box, { PURPLEFLOW_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
  const p = l.page;
  try {
    await p.getByRole('button', { name: 'Настройки' }).click();
    await p.getByRole('tab', { name: 'Аккаунт' }).click();
    await p.getByLabel('Email').fill(EMAIL);
    await p.locator('form.auth input[type=password]').fill('password123');
    await p.locator('form.auth').getByRole('button', { name: 'Войти' }).click();

    // После входа — переключатель (включён) и модели по ключу аккаунта, с ценой, если сервер её отдал.
    const sw = p.getByRole('switch', { name: 'Картинки, видео и озвучка в чате' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    const grid = p.getByRole('list', { name: 'Модели картинок' });
    await expect(grid.getByRole('listitem')).toHaveCount(3);
    await expect(grid.getByRole('listitem').first()).toContainText('по умолчанию');
    await expect(grid.getByRole('listitem').filter({ hasText: 'Flux 3 Klein' })).toContainText('6 400 кредитов');
    expect(seen.auth.every((a) => a === `Bearer ${KEY.proxyKey}`)).toBe(true);
    // Только пробный бонус — картинкам нужна подписка или пакет.
    await expect(p.getByRole('link', { name: 'Оформить подписку' })).toHaveAttribute('href', /purpleschool\.ru/);
    // Купил пакет — плашки нет.
    seen.paid = true;
    await p.getByRole('tab', { name: 'Статистика' }).click();
    await p.getByRole('tab', { name: 'Аккаунт' }).click();
    await expect(p.getByRole('list', { name: 'Модели картинок' })).toBeVisible();
    await expect(p.getByRole('link', { name: 'Оформить подписку' })).toHaveCount(0);

    // Чат: агент получил сервер и ключ (в окружении), нарисованная картинка — в ответе.
    await p.getByRole('button', { name: 'Создать', exact: true }).click();
    await p.getByRole('menuitem', { name: /Чат/ }).click();
    await p.locator('.chat-compose textarea').fill('Нарисуй кота НАРИСУЙ_КОТА');
    await p.keyboard.press('Enter');
    await expect(p.locator('.chat-msg.is-assistant').last()).toContainText('Нарисовал кота (ключ: env)');
    const card = p.locator('.chat-gen-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('figcaption')).toContainText('A cozy orange cat');
    await expect
      .poll(() =>
        card
          .locator('img')
          .evaluate((i: HTMLImageElement) => i.naturalWidth)
          .catch(() => 0),
      )
      .toBe(1);
    // Увеличить — картинка поверх окна, Esc закрывает.
    await card.hover();
    await card.getByRole('button', { name: 'Увеличить' }).click();
    const zoom = p.getByRole('dialog', { name: 'Картинка' });
    await expect(zoom.locator('img')).toBeVisible();
    await p.keyboard.press('Escape');
    await expect(zoom).toHaveCount(0);
    // Скачать — в файл, который выбрал человек (системный диалог в тесте отвечает сразу).
    const target = `${box.root}/saved-cat.png`;
    await l.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    }, target);
    await card.hover();
    await card.getByRole('button', { name: 'Скачать' }).click();
    await expect(card.locator('.chat-gen-saved')).toContainText('saved-cat.png');
    expect(fs.readFileSync(target).equals(PIXEL)).toBe(true);
    // Не хватило токенов — под ответом карточка подписки.
    await p.locator('.chat-compose textarea').fill('Нарисуй ещё НЕТ_ТОКЕНОВ');
    await p.keyboard.press('Enter');
    await expect(p.locator('.chat-msg.is-assistant').last()).toContainText('Нужна подписка PurpleSchool');
    await expect(p.locator('.chat-msg.is-assistant').last().getByRole('link', { name: 'Оформить подписку' })).toBeVisible();
    // Ключ аккаунта не попал в аргументы агента — только адрес сервера.
    const calls = fs.readFileSync(`${box.root}/calls.jsonl`, 'utf8');
    expect(calls).toContain('--mcp-config');
    expect(calls).not.toContain(KEY.proxyKey);

    // Выключили — агенту сервер не подключается.
    await p.getByRole('button', { name: 'Настройки' }).click();
    await p.getByRole('tab', { name: 'Аккаунт' }).click();
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  } finally {
    await quit(l);
    api.close();
  }
});

test('картинки без входа: просьба нарисовать — карточка входа, кнопка ведёт в «Аккаунт»', async () => {
  const box = makeSandbox({ settings: { enabledAgents: ['claude', 'codex'] } });
  const l = await launch(box, { PURPLEFLOW_API_URL: 'http://127.0.0.1:9' });
  const p = l.page;
  try {
    await p.getByRole('button', { name: 'Создать', exact: true }).click();
    await p.getByRole('menuitem', { name: /Чат/ }).click();
    await p.locator('.chat-compose textarea').fill('нарисуй кота для обложки');
    await p.keyboard.press('Enter');
    const card = p.locator('.chat-msg.is-assistant').last().locator('.chat-offer');
    await expect(card).toContainText('Войдите в PurpleSchool');
    await card.getByRole('button', { name: 'Войти или зарегистрироваться' }).click();
    await expect(p.getByRole('heading', { name: 'Вход в PurpleSchool' })).toBeVisible();
  } finally {
    await quit(l);
  }
});

test('«Создать» без входа: замок, подсказка над полем при каждом нажатии и переход ко входу', async () => {
  const box = makeSandbox({ settings: { enabledAgents: ['claude', 'codex'] } });
  const l = await launch(box, { PURPLEFLOW_API_URL: 'http://127.0.0.1:9' });
  const p = l.page;
  try {
    await p.getByRole('button', { name: 'Создать', exact: true }).click();
    await p.getByRole('menuitem', { name: /Чат/ }).click();
    const gen = p.locator('.chat-compose').getByRole('button', { name: 'Создать', exact: true });
    // Замок и подсказка при наведении; в меню «Картинка» тоже с замком.
    await gen.hover();
    await expect(p.locator('.chat-gen-wrap').getByRole('tooltip')).toContainText('после входа в PurpleSchool');
    await gen.click();
    await expect(p.getByRole('option', { name: /Картинка/ })).toContainText('Нужен вход в PurpleSchool');
    await p.getByRole('option', { name: /Картинка/ }).click();
    // Режим не включился — вместо него подсказка войти.
    await expect(p.getByRole('group', { name: 'Создать картинку' })).toHaveCount(0);
    const hint = p.locator('.compose-login');
    await expect(hint).toContainText('Войдите в PurpleSchool');
    await hint.getByRole('button', { name: 'Скрыть подсказку' }).click();
    await expect(hint).toHaveCount(0);
    // Повторное нажатие показывает подсказку снова; кнопка ведёт на вход.
    await gen.click();
    await p.getByRole('option', { name: /Картинка/ }).click();
    await hint.getByRole('button', { name: 'Войти в PurpleSchool' }).click();
    await expect(p.getByRole('heading', { name: 'Вход в PurpleSchool' })).toBeVisible();
  } finally {
    await quit(l);
  }
});

test('«Создать картинку»: кнопкой и командой /картинка — агенту уходит явная просьба с моделью и сторонами', async () => {
  const api = fakeApi({ auth: [], paid: true });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const box = makeSandbox({ settings: { enabledAgents: ['claude', 'codex'] } });
  const l = await launch(box, { PURPLEFLOW_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
  const p = l.page;
  const field = p.locator('.chat-compose textarea');
  const lastPrompt = () => box.calls().at(-1)?.prompt ?? '';
  try {
    await p.getByRole('button', { name: 'Настройки' }).click();
    await p.getByRole('tab', { name: 'Аккаунт' }).click();
    await p.getByLabel('Email').fill(EMAIL);
    await p.locator('form.auth input[type=password]').fill('password123');
    await p.locator('form.auth').getByRole('button', { name: 'Войти' }).click();
    await expect(p.getByRole('switch', { name: 'Картинки, видео и озвучка в чате' })).toBeVisible();
    await p.getByRole('button', { name: 'Создать', exact: true }).click();
    await p.getByRole('menuitem', { name: /Чат/ }).click();
    // Кнопка «Создать» → «Картинка»: плашка режима; стороны 16:9.
    await p.locator('.chat-compose').getByRole('button', { name: 'Создать', exact: true }).click();
    await p.getByRole('option', { name: /Картинка/ }).click();
    const pill = p.getByRole('group', { name: 'Создать картинку' });
    await expect(pill).toBeVisible();
    await expect(field).toHaveAttribute('placeholder', /Опишите картинку/);
    await pill.getByRole('button', { name: 'Соотношение сторон' }).click();
    await p.getByRole('option', { name: '16:9' }).click();
    await field.fill('рыжий котёнок');
    await field.press('Enter');
    await expect.poll(lastPrompt).toContain('Сгенерируй картинку через generate_image (соотношение сторон 16:9): рыжий котёнок');
    await expect(pill).toHaveCount(0);

    // «/карт» → подсказка «/картинка» → режим; команда из текста убирается.
    await field.fill('/карт');
    await p.getByRole('option', { name: /\/картинка/ }).click();
    await expect(pill).toBeVisible();
    await expect(field).toHaveValue('');
    await pill.getByRole('button', { name: 'Выйти из режима картинки' }).click();
    await expect(pill).toHaveCount(0);

    // Набрали «/картинка …» и сразу отправили — тоже просьба нарисовать.
    await field.fill('/картинка лиса в лесу');
    await field.press('Escape');
    await field.press('Enter');
    await expect.poll(lastPrompt).toContain('Сгенерируй картинку через generate_image: лиса в лесу');
  } finally {
    await quit(l);
    api.close();
  }
});
