// MCP-серверы проекта: список из .mcp.json и окно «Добавить MCP» с поиском по реестру (здесь — локальный сервер).
// Статистика проекта — на своей вкладке.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

test('mcp: список проекта, поиск в реестре с полями ключей, статистика на вкладке', async () => {
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    queries.push(new URL(req.url ?? '/', 'http://x').searchParams.get('search') ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        servers: [
          {
            server: {
              name: 'io.github.acme/figma-mcp',
              title: 'Figma',
              description: 'Макеты Figma для агента',
              version: '1.2.0',
              packages: [
                {
                  registryType: 'npm',
                  identifier: '@acme/figma-mcp',
                  transport: { type: 'stdio' },
                  environmentVariables: [{ name: 'FIGMA_TOKEN', isRequired: true, isSecret: true, description: 'Токен Figma' }],
                },
              ],
            },
          },
          // Без вариантов установки — не показываем.
          { server: { name: 'io.github.acme/empty', description: 'нечего ставить', version: '0.1.0' } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v0/servers`;
  const box = makeSandbox();
  const home = path.join(box.root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(box.repo, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        postgres: { command: 'npx', args: ['-y', 'pg-mcp'], env: { PG_URL: 'postgres://секрет' } },
        'broken-api': { type: 'http', url: 'https://broken.example/mcp' },
      },
    }),
  );
  const l = await launch(box, { PURPLEFLOW_MCP_REGISTRY_URL: url, HOME: home });
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Проекты', exact: true }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    await page.getByRole('tab', { name: 'Обзор' }).click();
    const panel = page.locator('.overview-mcp');
    await expect(panel).toContainText('postgres');
    await expect(panel).toContainText('npx -y pg-mcp');
    // Имена ключей видны, значения — нет.
    await expect(panel).toContainText('PG_URL');
    await expect(page.getByText('postgres://секрет')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Удалить postgres' })).toBeVisible();
    // Проверка серверов: claude сам говорит, кто подключился.
    await expect(panel.locator('.mcp-health')).toHaveText(/работают 1 из 2/);
    await expect(panel.getByRole('listitem').filter({ hasText: 'broken-api' })).toContainText('не подключился');
    await expect(panel.getByRole('listitem').filter({ hasText: 'postgres' }).getByRole('img', { name: 'подключён' })).toBeVisible();

    // Правка: новая команда и ключ; пустой ключ остаётся прежним.
    await panel.getByRole('button', { name: 'Изменить postgres' }).click();
    const edit = page.getByRole('dialog', { name: 'Изменить postgres' });
    await expect(edit.getByLabel('Команда запуска')).toHaveValue('npx -y pg-mcp');
    await expect(edit.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await edit.getByLabel('Команда запуска').fill('npx -y pg-mcp@2');
    await edit.getByLabel('PG_URL').fill('postgres://новый');
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-mcp-edit.png') });
    }
    await edit.getByRole('button', { name: 'Сохранить' }).click();
    await expect(edit).toHaveCount(0);
    await expect(panel).toContainText('npx -y pg-mcp@2');
    const saved = JSON.parse(fs.readFileSync(path.join(box.repo, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
    };
    expect(saved.mcpServers.postgres).toMatchObject({ args: ['-y', 'pg-mcp@2'], env: { PG_URL: 'postgres://новый' } });
    await expect(page.getByText('postgres://новый')).toHaveCount(0);

    // Удаление в два шага. Вопрос перед удалением не снимается по времени: неспешный второй клик удаляет.
    await panel.getByRole('button', { name: 'Удалить broken-api' }).click();
    await page.waitForTimeout(4500);
    await panel.getByRole('button', { name: 'Удалить из проекта?' }).click();
    await expect(panel.getByText('broken-api')).toHaveCount(0);
    await expect(panel.locator('.mcp-health')).toHaveText(/все работают/);
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-mcp-panel.png') });

    await panel.getByRole('button', { name: 'Добавить MCP' }).click();
    const dialog = page.getByRole('dialog', { name: 'Добавить MCP' });
    await dialog.getByLabel('Поиск MCP').fill('figma');
    const list = dialog.getByRole('list', { name: 'Найденные MCP-серверы' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('Figma');
    await list.getByRole('button', { name: 'Добавить' }).click();
    await expect(list).toContainText('npx -y @acme/figma-mcp');
    await expect(list.getByLabel('Имя в настройках')).toHaveValue('figma-mcp');
    const token = list.getByLabel('FIGMA_TOKEN');
    await expect(token).toHaveAttribute('type', 'password');
    // Обязательный ключ не заполнен — ставить рано.
    await expect(list.getByRole('button', { name: 'Установить' })).toBeDisabled();
    await token.fill('figd_test');
    await expect(list.getByRole('button', { name: 'Установить' })).toBeEnabled();
    expect(queries.at(-1)).toBe('figma');
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-mcp-search.png') });
    }
    await dialog.getByRole('button', { name: 'Готово' }).click();
    await expect(dialog).toHaveCount(0);

    // Статистика ушла с обзора на свою вкладку.
    await expect(page.locator('.project-tab').getByText('Статистика', { exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Статистика' }).click();
    await expect(page.getByRole('tab', { name: 'Статистика' })).toHaveAttribute('aria-selected', 'true');
    // Прогоны — тоже здесь, а не на обзоре.
    await expect(page.getByText('Прогонов в этом проекте ещё не было.')).toBeVisible();
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
    server.close();
  }
});
