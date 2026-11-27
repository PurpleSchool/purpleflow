import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, openRepoProject } from './harness';

// Картинка в диффе: вместо «Бинарный файл» — было и стало рядом.
const PIXEL_GREEN = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PIXEL_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('дифф: картинка — было и стало рядом, а не «бинарный файл»', async () => {
  const box = makeSandbox();
  fs.writeFileSync(path.join(box.repo, 'logo.png'), Buffer.from(PIXEL_GREEN, 'base64'));
  box.git('add', '-A');
  box.git('commit', '-qm', 'Логотип');
  fs.writeFileSync(path.join(box.repo, 'logo.png'), Buffer.from(PIXEL_RED, 'base64'));
  box.git('commit', '-qam', 'Новый логотип');
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Проекты', exact: true }).click();
    await openRepoProject(page);
    await page.getByRole('tab', { name: 'Git' }).click();
    await page.getByRole('list', { name: 'История коммитов' }).getByRole('listitem').filter({ hasText: 'Новый логотип' }).click();
    const media = page.locator('.diff-media');
    await expect(media.locator('figure')).toHaveCount(2);
    await expect(media.locator('figcaption').first()).toContainText('Было');
    await expect(media.locator('figcaption').last()).toContainText('Стало');
    // Картинки настоящие: браузер их декодировал, размер подписан.
    await expect
      .poll(() =>
        media
          .locator('img')
          .first()
          .evaluate((i: HTMLImageElement) => i.naturalWidth),
      )
      .toBe(1);
    await expect(media.locator('figcaption').last()).toContainText('1×1');
    await expect(page.getByText('Бинарный файл')).toHaveCount(0);
  } finally {
    await quit(l);
  }
});
