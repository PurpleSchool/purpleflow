// Скиллы проекта: окно «Добавить скиллы» ищет по каталогу (здесь — локальный сервер вместо skills.sh).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, openRepoProject } from './harness';

test('скиллы: поиск по каталогу показывает источник и число установок', async () => {
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    queries.push(new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        skills: [
          {
            id: 'vercel-labs/agent-skills/vercel-react-native-skills',
            source: 'vercel-labs/agent-skills',
            skillId: 'vercel-react-native-skills',
            name: 'vercel-react-native-skills',
            installs: 290343,
          },
          { id: 'bad', source: 'не репозиторий', skillId: 'x', name: 'x', installs: 1 },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/search`;
  const box = makeSandbox();
  const l = await launch(box, { PURPLEFLOW_SKILLS_SEARCH_URL: url });
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Проекты', exact: true }).click();
    await openRepoProject(page);
    await page.getByRole('tab', { name: 'Обзор' }).click();
    await page.getByRole('button', { name: 'Добавить скиллы' }).click();
    const dialog = page.getByRole('dialog', { name: 'Добавить скиллы' });
    await dialog.getByLabel('Поиск скиллов').fill('react native');
    const list = dialog.getByRole('list', { name: 'Найденные скиллы' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('vercel-react-native-skills');
    await expect(list).toContainText('vercel-labs/agent-skills · 290 тыс. установок');
    await expect(list.getByRole('button', { name: 'Установить' })).toBeEnabled();
    // Для каких агентов ставить: по умолчанию все включённые; сняли всех — ставить некому.
    const agents = dialog.getByRole('group', { name: 'Для агентов' });
    const claude = agents.getByRole('button', { name: 'claude' });
    await expect(claude).toHaveAttribute('aria-pressed', 'true');
    for (const b of await agents.getByRole('button').all()) await b.click();
    await expect(list.getByRole('button', { name: 'Установить' })).toBeDisabled();
    await claude.click();
    await expect(list.getByRole('button', { name: 'Установить' })).toBeEnabled();
    expect(queries.at(-1)).toBe('react native');
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-skills-search.png') });
    }
    // «Куда ставить» у правого края: список остаётся в окне, у окна нет прокрутки вбок.
    await dialog.getByRole('button', { name: 'Куда ставить' }).click();
    const pop = page.getByRole('listbox');
    await expect(pop.getByRole('option', { name: /Для всех проектов/ })).toBeVisible();
    const dims = await dialog.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, right: el.getBoundingClientRect().right }));
    expect(dims.sw).toBeLessThanOrEqual(dims.cw);
    expect((await pop.boundingBox())!.x + (await pop.boundingBox())!.width).toBeLessThanOrEqual(dims.right);
    // Escape закрывает только список, диалог остаётся.
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Готово' }).click();
    await expect(dialog).toHaveCount(0);
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
    server.close();
  }
});
