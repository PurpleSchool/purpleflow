import { expect, test, type Page } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

// Терминал в панели чата: настоящая оболочка в PTY (node-pty), живёт при переключении инструментов.
const screenText = (page: Page) => page.locator('.term-host:visible .xterm-rows').innerText();

test('терминал чата: оболочка в папке проекта, размер окна, вывод живёт при уходе в другой инструмент, Ctrl+C', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  try {
    const page = l.page;
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.locator('.chat-compose textarea').fill('Привет');
    await page.keyboard.press('Enter');
    await page.locator('.chat-msg.is-assistant').waitFor();
    const rail = page.getByRole('navigation', { name: 'Вкладки панели' });
    await rail.getByRole('button', { name: 'Терминал' }).click();
    const term = page.locator('.term-host:visible .xterm');
    await term.waitFor();
    await term.click();
    // Оболочка — настоящий терминал: знает свою ширину, команды выполняются.
    await page.keyboard.type('echo pf-$((40+2)) cols=$(tput cols)');
    await page.keyboard.press('Enter');
    await expect.poll(() => screenText(page), { timeout: 20_000 }).toMatch(/pf-42 cols=\d{2,}/);
    const cols = Number(/pf-42 cols=(\d+)/.exec(await screenText(page))![1]);
    expect(cols).toBeGreaterThan(30);
    // Ушли в «Браузер» и вернулись — тот же терминал с выводом.
    await rail.getByRole('button', { name: 'Браузер', exact: true }).click();
    await rail.getByRole('button', { name: 'Терминал' }).click();
    await expect.poll(() => screenText(page)).toContain('pf-42');
    // Закрыли панель тем же значком и открыли снова — терминал на месте, с выводом.
    await rail.getByRole('button', { name: 'Терминал' }).click();
    await expect(page.locator('.term-host:visible')).toHaveCount(0);
    await rail.getByRole('button', { name: 'Терминал' }).click();
    await expect.poll(() => screenText(page)).toContain('pf-42');
    // Ctrl+C прерывает команду.
    await term.click();
    // Вывод отличается от набранного ($((1)) → 1): набранная строка при длинном приглашении переносится и может
    // попасть на экран дважды, а проверяем мы только вывод команд.
    await page.keyboard.type('sleep 30; echo не-$((1))-прервано');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+C');
    await page.keyboard.type('echo после-$((1))-прерывания');
    await page.keyboard.press('Enter');
    await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain('после-1-прерывания');
    // echo после sleep не выполнился.
    expect(await screenText(page)).not.toContain('не-1-прервано');
    // Вторая вкладка — отдельная оболочка.
    await page.getByRole('button', { name: 'Новый терминал' }).click();
    await expect(page.locator('.term-pane').getByRole('tab')).toHaveCount(2);
    await page.locator('.term-host:visible .xterm').click();
    await page.keyboard.type('echo second-$((1+1))');
    await page.keyboard.press('Enter');
    await expect.poll(() => screenText(page), { timeout: 20_000 }).toContain('second-2');
    expect(await screenText(page)).not.toContain('pf-42');
    // exit — вкладка помечена завершённой.
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await expect(page.locator('.term-pane').getByRole('tab').nth(1)).toContainText('завершён', { timeout: 10_000 });
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
  }
});
