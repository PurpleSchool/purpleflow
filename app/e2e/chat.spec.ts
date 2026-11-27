// Чат: режим, агент и модель под полем ввода; ответ с таблицей и блоком кода с подсветкой и копированием.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

test('чат: ссылка с параметром сохраняет черновик, ссылка на якорь работает', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('Покажи ссылки Markdown');
    await input.press('Enter');

    const answer = page.locator('.chat-msg.is-assistant');
    const queryLink = answer.getByRole('link', { name: 'Параметр' });
    await expect(queryLink).toBeVisible();
    await input.fill('Несохранённый черновик');
    const url = new URL('#example', page.url()).href;
    await answer.getByRole('link', { name: 'Якорь' }).click();
    await expect(page).toHaveURL(url);
    await expect(input).toHaveValue('Несохранённый черновик');

    // Playwright waits for a navigation that Electron cancels in the main process.
    await queryLink.click({ noWaitAfter: true });
    const afterClick = await l.app.evaluate(async ({ BrowserWindow }) => {
      const { webContents } = BrowserWindow.getAllWindows()[0];
      return webContents.executeJavaScript(`({ url: location.href, draft: document.querySelector('.chat-compose textarea')?.value })`);
    });
    expect(afterClick).toEqual({ url, draft: 'Несохранённый черновик' });

    // Перезагрузка окна (кнопка в ErrorBoundary) по-прежнему работает.
    await page.evaluate(() => Object.assign(window, { beforeReload: true }));
    await Promise.all([page.waitForEvent('load'), page.evaluate(() => setTimeout(() => location.reload()))]);
    expect(await page.evaluate(() => 'beforeReload' in window)).toBe(false);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: агент без вызова просит полный доступ текстом (как codex) — карточка запроса есть', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('Закоммить молча');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Дать доступ и повторить' })).toBeVisible();
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-access.png') });
    }
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: песочница правок не пустила команду — запрос полного доступа, после него повтор без песочницы', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('Закоммить правки');
    await input.press('Enter');

    const grant = page.getByRole('button', { name: 'Дать доступ и повторить' });
    await expect(grant).toBeVisible();
    await grant.click();
    await expect(page.getByRole('button', { name: 'Режим' })).toContainText('Полный доступ');
    await expect(page.locator('.chat-msg.is-assistant').last()).toContainText('Закоммитил.');
    // Карточка только у ответа, который ещё можно продолжить, и только в режиме правок.
    await expect(grant).toHaveCount(0);
    const chats = box.calls().filter((c) => /Закоммить правки|Включил полный доступ/.test(c.prompt));
    expect(chats.at(-1)!.args.join(' ')).not.toContain('"sandbox"');
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: панель под полем ввода, таблица и блок кода в ответе', async () => {
  const box = makeSandbox();
  // Свой HOME: github — ваш MCP-сервер claude, его можно изменить и удалить с вкладки «Сессия».
  const home = path.join(box.root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://gh.example/mcp' } } }),
  );
  const l = await launch(box, { HOME: home });
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();

    const bar = page.locator('.chat-compose-bar');
    // Режим — выпадающий список из трёх: по умолчанию правки.
    const mode = bar.getByRole('button', { name: 'Режим' });
    await expect(mode).toContainText('Правки');
    await mode.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText([/Вопросы/, /Правки/, /Полный доступ/]);
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-mode.png') });
    await page.getByRole('option', { name: /Вопросы/ }).click();
    await expect(mode).toContainText('Вопросы');
    // Агент и модель — одна кнопка; своей модели у чата нет — на ней модель по умолчанию из настроек, а не пустота.
    const picker = bar.getByRole('button', { name: 'Агент и модель' });
    await expect(picker).toHaveText(/claude\s*·\s*sonnet/);
    await expect(picker.locator('.amp-model')).toHaveClass(/is-default/);
    // Список разбит на разделы по включённым агентам; выбор модели выбирает и агента.
    await picker.click();
    const pop = page.locator('.amp-pop');
    await expect(pop.getByRole('group', { name: 'claude' })).toBeVisible();
    await expect(pop.getByRole('group', { name: 'codex' })).toBeVisible();
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-picker.png') });
    }
    await pop.getByRole('group', { name: 'codex' }).getByRole('option').nth(1).click();
    await expect(picker).toHaveText(/codex\s*·\s*gpt/);
    // Поиск: своё имя модели у текущего агента.
    await picker.click();
    await pop.getByLabel('Найти модель').fill('my-model');
    await pop.getByLabel('Найти модель').press('Enter');
    await expect(picker).toHaveText(/codex\s*·\s*my-model/);
    // Назад на claude по умолчанию.
    await picker.click();
    await pop.getByRole('group', { name: 'claude' }).getByRole('option', { name: 'по умолчанию' }).click();
    await expect(picker).toHaveText(/claude\s*·\s*sonnet/);

    await page.locator('.chat-compose textarea').fill('Как устроены контейнеры?');
    await page.keyboard.press('Enter');

    const answer = page.locator('.chat-msg.is-assistant');
    await expect(answer.locator('.md-table table td', { hasText: 'cgroups' })).toBeVisible({ timeout: 30_000 });
    const code = answer.locator('.md-code');
    await expect(code.locator('.md-code-lang')).toHaveText('ts');
    await expect(code.locator('.hljs-keyword', { hasText: 'const' })).toBeVisible();

    // «Копировать» — иконка; после клика — галочка и текст блока в буфере.
    const copy = code.getByRole('button', { name: 'Копировать' });
    await expect(copy.locator('svg.md-copy-icon')).toHaveCount(1);
    await code.hover();
    await copy.click();
    await expect(copy).toHaveClass(/is-done/);
    await expect(copy.locator('svg.md-copy-done')).toBeVisible();
    expect(await l.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('const a: number = 1;');
    // Чат был в режиме «Вопросы»: агенту ушёл только набор инструментов для чтения.
    expect(box.calls().at(-1)?.args.join(' ')).toMatch(/--tools Read,Grep,Glob,WebSearch,WebFetch/);
    expect(box.calls().at(-1)?.args.join(' ')).toMatch(/--model sonnet/);

    // Свёрнутая панель показывает заполнение контекста; по клику — вкладка «Сессия».
    const rail = page.getByRole('button', { name: 'Сессия' });
    await expect(rail).toContainText('25%');
    await rail.click();
    const ses = page.locator('.ses');
    await expect(ses.locator('.ses-ctx-num')).toHaveText('50 тыс. из 200 тыс.');
    // Полоса значков всегда на месте: «Сессия» открыта слева от неё, с заголовком, значок нажат.
    const sidePanel = page.getByRole('region', { name: 'Код и браузер' });
    await expect(sidePanel.getByRole('heading', { name: 'Сессия' })).toBeVisible();
    await expect(rail).toHaveAttribute('aria-pressed', 'true');
    const railBox = (await page.getByRole('complementary', { name: 'Панель чата' }).boundingBox())!;
    expect((await sidePanel.boundingBox())!.x).toBeLessThan(railBox.x);
    // Чат без проекта: «Файлы» — рабочая папка чата.
    await page.getByRole('navigation', { name: 'Вкладки панели' }).getByRole('button', { name: 'Файлы чата' }).click();
    await expect(sidePanel.getByRole('heading', { name: 'Файлы чата' })).toBeVisible();
    await rail.click();
    await expect(sidePanel.getByRole('heading', { name: 'Сессия' })).toBeVisible();
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-side-tabs.png') });
    await expect(ses).toContainText('занято 25% окна модели');
    const gh = ses.locator('.ses-mcp li', { hasText: 'github' });
    await expect(gh).toContainText('подключён');
    await gh.getByRole('button', { name: 'Изменить github' }).click();
    const edit = page.getByRole('dialog', { name: 'Изменить github' });
    await expect(edit.getByLabel('Адрес')).toHaveValue('https://gh.example/mcp');
    await edit.getByRole('button', { name: 'Отмена' }).click();
    await expect(edit).toHaveCount(0);
    await expect(ses.getByText('Вопросы — только чтение')).toBeVisible();
    await expect(ses.getByText('fake')).toBeVisible();

    // «Сжать контекст»: /compact в той же сессии, в ленте — уведомление, заполнение — после сжатия.
    await ses.getByRole('button', { name: 'Сжать контекст' }).click();
    await expect(page.locator('.chat-msg.is-assistant').last()).toContainText('Контекст переписки сжат (50 тыс. → 9 тыс. токенов)');
    await expect(ses.locator('.ses-ctx-num')).toHaveText('9 тыс. из 200 тыс.');
    await expect(ses.getByText('В этой сессии контекст уже сжимался.')).toBeVisible();
    expect(box.calls().at(-1)?.prompt).toBe('/compact');
    expect(box.calls().at(-1)?.args.join(' ')).toMatch(/--resume /);

    // Удалить MCP-сервер прямо из сессии: два шага, агент подхватит при следующем запуске.
    await gh.getByRole('button', { name: 'Удалить github' }).click();
    await ses.getByRole('button', { name: 'Удалить у claude во всех проектах?' }).click();
    await expect(ses.locator('.ses-mcp li', { hasText: 'github' })).toHaveCount(0);
    await expect(ses).toContainText('Агент подхватит изменения при следующем запуске.');
    expect(box.calls().some((c) => c.args.join(' ') === 'mcp remove github -s user')).toBe(true);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: «@» подставляет файл проекта, «/» — скилл; агенту уходят их пути', async () => {
  // Свои скиллы из ~/.claude, ~/.agents в проверке не участвуют: иначе «/re» у разработчика попадает
  // в его собственный скилл, и список подсказок зависит от машины, а не от проекта.
  const box = makeSandbox({ settings: { userConfig: false } });
  const skill = path.join(box.repo, '.claude', 'skills', 'review', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\ndescription: Ревью по чек-листу\n---\n');
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    // Проект — через «Выбрать папку…»: системный диалог в обвязке отвечает папкой песочницы.
    await page.getByRole('button', { name: 'Проект', exact: true }).click();
    await page.getByRole('option', { name: /Выбрать папку/ }).click();
    await expect(page.getByRole('heading', { name: /Спросите о demo/ })).toBeVisible();

    const input = page.locator('.chat-compose textarea');
    await input.click();
    await page.keyboard.type('/re');
    const skills = page.getByRole('listbox', { name: 'Скиллы' });
    await expect(skills.getByRole('option', { name: /\/review.*Ревью по чек-листу.*проект/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('/review ');

    await page.keyboard.type('@mat');
    const files = page.getByRole('listbox', { name: 'Файлы проекта' });
    await expect(files.getByRole('option', { name: /math\.js/ })).toBeVisible();
    // Escape закрывает список, а следующая буква снова его открывает.
    await page.keyboard.press('Escape');
    await expect(files).toHaveCount(0);
    await page.keyboard.type('h');
    await expect(files.getByRole('option', { name: /math\.js/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('/review @src/math.js ');

    await page.keyboard.type('что тут?');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-msg.is-user')).toContainText('/review @src/math.js что тут?');
    await expect.poll(() => box.calls().at(-1)?.prompt ?? '').toContain(`- /review: ${skill}`);
    expect(box.calls().at(-1)!.prompt).toContain(`- ${path.join(box.repo, 'src', 'math.js')}`);

    // «Сессия»: скиллы рядом с MCP; незакоммиченный помечен — прогон в отдельной копии его не увидит.
    await page.getByRole('button', { name: 'Сессия' }).click();
    const ses = page.locator('.ses-skills');
    await expect(ses.locator('li').filter({ has: page.locator('.skill-name', { hasText: /^review$/ }) })).toContainText('не в git');

    // Экран проекта: те же скиллы и какие агенты найдут их сами.
    await page.getByRole('button', { name: 'Проекты' }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    await page.getByRole('tab', { name: 'Обзор' }).click();
    const panel = page.locator('.overview-skills');
    // Скиллы — вкладками по агентам с числом скиллов: review из .claude/skills — у claude.
    // Вкладки есть, только когда скиллы нашлись у нескольких агентов; с одним агентом его список показан сразу.
    const claudeTab = panel.getByRole('tab', { name: /^claude\s*\d+$/ });
    if (await claudeTab.count()) await claudeTab.click();
    const review = panel.locator('.skill-list li').filter({ has: page.locator('.skill-name', { hasText: /^review$/ }) });
    await expect(review).toContainText('Ревью по чек-листу');
    // «Проект» раскрыт; заголовок сворачивает и снова разворачивает список. Ваши (если есть) — свёрнуты.
    const projectHead = panel.getByRole('button', { name: /^Проект\s*\d+$/ });
    await expect(projectHead).toHaveAttribute('aria-expanded', 'true');
    await projectHead.click();
    await expect(review).toHaveCount(0);
    await projectHead.click();
    await expect(review).toBeVisible();
    const userHead = panel.getByRole('button', { name: /^Ваши — для всех проектов/ });
    if (await userHead.count()) await expect(userHead).toHaveAttribute('aria-expanded', 'false');
    if (process.env.PF_SHOT) {
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.PF_SHOT });
    }

    // Копирование другому агенту: review из .claude/skills — для codex в .agents/skills.
    await review.getByRole('button', { name: 'Скопировать review другому агенту' }).click();
    await review.getByRole('button', { name: 'в codex' }).click();
    await expect.poll(() => fs.existsSync(path.join(box.repo, '.agents', 'skills', 'review', 'SKILL.md'))).toBe(true);
    await panel.getByRole('tab', { name: /^codex\s*\d+$/ }).click();
    await expect(panel.locator('.skill-list .skill-name', { hasText: /^review$/ })).toBeVisible();
    fs.rmSync(path.join(box.repo, '.agents', 'skills', 'review'), { recursive: true });
    await claudeTab.click();

    // Удаление: положенный руками скилл уходит в корзину системы (здесь — заглушка), после подтверждения.
    await l.app.evaluate(({ shell }) => {
      shell.trashItem = (async (p: string) => {
        const fs = process.getBuiltinModule('node:fs');
        fs.rmSync(p, { recursive: true, force: true });
      }) as typeof shell.trashItem;
    });
    // Кнопка удаления видна сразу, без наведения.
    await expect(review.getByRole('button', { name: 'Удалить review' })).toBeVisible();
    await review.getByRole('button', { name: 'Удалить review' }).click();
    await review.getByRole('button', { name: 'Удалить из проекта?' }).click();
    await expect(panel.locator('.skill-name', { hasText: /^review$/ })).toHaveCount(0);
    expect(fs.existsSync(path.dirname(skill))).toBe(false);
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: вкладка «Файлы» — дерево проекта, содержимое файла по клику, «@путь» перетаскиванием и кнопкой «+»', async () => {
  const box = makeSandbox();
  // Картинка 1×1 — вкладка показывает её, а не «двоичный файл».
  fs.writeFileSync(
    path.join(box.repo, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  );
  box.git('add', 'pixel.png');
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.getByRole('button', { name: 'Проект', exact: true }).click();
    await page.getByRole('option', { name: /Выбрать папку/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('привет');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible();

    // Панель справа свёрнута в полосу — разворачиваем и открываем «Файлы».
    // Свёрнутая панель: иконка вкладки открывает сразу её.
    await page.getByRole('navigation', { name: 'Вкладки панели' }).getByRole('button', { name: 'Файлы проекта' }).click();
    const tree = page.getByRole('tree', { name: 'Файлы проекта' });
    // Инструмент — слева от полосы, с заголовком; самая узкая ширина — полоса остаётся на месте.
    const filesPanel = page.getByRole('region', { name: 'Код и браузер' });
    await expect(filesPanel.getByRole('heading', { name: 'Файлы проекта' })).toBeVisible();
    // Панель выезжает с анимацией — тянем ручку, когда она встала на место.
    await page.waitForTimeout(500);
    const grip = (await page.locator('.side-resize').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 2000, grip.y + grip.height / 2, { steps: 5 });
    await page.mouse.up();
    const narrow = (await filesPanel.boundingBox())!;
    expect(narrow.width).toBeLessThan(420);
    const strip = (await page.getByRole('complementary', { name: 'Панель чата' }).boundingBox())!;
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(strip.x);
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-side-narrow.png') });
    const src = tree.getByRole('treeitem', { name: 'src' });
    await src.getByRole('button', { name: 'src', exact: true }).click();
    const math = src.getByRole('treeitem', { name: 'math.js' }).getByRole('button', { name: 'math.js', exact: true });
    await math.dragTo(input);
    await expect(input).toHaveValue('@src/math.js ');
    // Папку — тоже перетаскиванием; файл — ещё и кликом.
    await src.getByRole('button', { name: 'src', exact: true }).first().dragTo(input);
    await expect(input).toHaveValue('@src/math.js @src ');
    // «+» при наведении — в контекст; клик по файлу — его содержимое.
    await page.getByRole('textbox', { name: 'Найти файл' }).fill('math');
    const hit = page.getByRole('list', { name: 'Найденные файлы' }).getByRole('listitem', { name: 'src/math.js' });
    await hit.getByRole('button', { name: 'Добавить в контекст: src/math.js' }).click();
    await expect(input).toHaveValue('@src/math.js @src @src/math.js ');
    await hit.getByRole('button', { name: 'src/math.js', exact: true }).click();
    await expect(page.locator('.chat-file-view')).toContainText('export const add');
    // Подсветка есть: ключевое слово — отдельным токеном с цветом.
    await expect(page.locator('.chat-file-view .view-line span[class*="mtk"]').filter({ hasText: 'export' })).not.toHaveClass(/mtk1\b/);
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-files.png') });
    await page.getByRole('button', { name: 'Файлы', exact: true }).last().click();
    await expect(page.getByRole('textbox', { name: 'Найти файл' })).toBeVisible();
    // JSON тоже подсвечен: ключи — строками, не простым текстом.
    await page.getByRole('textbox', { name: 'Найти файл' }).fill('package');
    await page
      .getByRole('list', { name: 'Найденные файлы' })
      .getByRole('listitem', { name: 'package.json' })
      .getByRole('button', { name: 'package.json', exact: true })
      .click();
    await expect(page.locator('.chat-file-view .view-line span[class*="mtk"]').filter({ hasText: '"name"' })).not.toHaveClass(/mtk1\b/);
    await page.getByRole('button', { name: 'Файлы', exact: true }).last().click();
    await page.getByRole('textbox', { name: 'Найти файл' }).fill('pixel');
    await page
      .getByRole('list', { name: 'Найденные файлы' })
      .getByRole('listitem', { name: 'pixel.png' })
      .getByRole('button', { name: 'pixel.png', exact: true })
      .click();
    const img = page.getByRole('img', { name: 'pixel.png' });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
    await page.getByRole('button', { name: 'Файлы', exact: true }).last().click();

    await input.fill('@src/math.js что тут?');
    await input.press('Enter');
    await expect.poll(() => box.calls().at(-1)?.prompt ?? '').toContain(`- ${path.join(box.repo, 'src', 'math.js')}`);
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('Git (просмотр): ветки, история с графом и дифф коммита — на странице проекта и в чате', async () => {
  const box = makeSandbox();
  // Ветка с одним коммитом поверх main и слияние — чтобы в графе были две линии.
  box.git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(box.repo, 'src/feature.js'), 'export const f = 1;\n');
  box.git('add', '-A');
  box.git('commit', '-qm', 'Фича');
  box.git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(box.repo, 'src/math.js'), 'export const add = (a, b) => a + b + 0;\n');
  box.git('commit', '-qam', 'Правка в main');
  box.git('checkout', '-qb', 'later');
  fs.writeFileSync(path.join(box.repo, 'later.txt'), 'потом\n');
  box.git('add', '-A');
  box.git('commit', '-qm', 'Позже');
  box.git('checkout', '-q', 'main');
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Проекты', exact: true }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    await page.getByRole('tab', { name: 'Git' }).click();
    const log = page.getByRole('list', { name: 'История коммитов' });
    await expect(log.getByRole('listitem')).toHaveCount(4);
    // Первый коммит репозитория — внизу: родители ниже детей.
    await expect(log.getByRole('listitem').last()).toContainText('Начало');
    await expect(page.locator('.git-graph circle')).toHaveCount(4);

    // Ветки: текущая, отставание и опережение относительно main.
    await page.getByRole('button', { name: /main · веток: 3/ }).click();
    const branches = page.getByRole('list', { name: 'Ветки' });
    await expect(branches.getByRole('listitem').filter({ hasText: 'later' })).toContainText('↑1 ↓0');
    await expect(branches.getByRole('listitem').filter({ hasText: 'feature' })).toContainText('↑1 ↓1');
    // Ревью — у веток со своими коммитами; у основной его нет.
    await expect(branches.getByRole('button', { name: 'Ревью ветки feature' })).toBeVisible();
    await expect(branches.getByRole('button', { name: 'Ревью ветки main' })).toHaveCount(0);
    await branches.getByRole('listitem').filter({ hasText: 'feature' }).getByRole('button', { name: 'feature', exact: true }).click();
    await expect(log.locator('.git-row.is-marked')).toContainText('Фича');
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-git.png') });

    // Коммит — его дифф.
    await log.getByRole('listitem').filter({ hasText: 'Правка в main' }).click();
    await expect(page.locator('.git-commit-title')).toHaveText('Правка в main');
    await expect(page.locator('.git-diff')).toContainText('math.js');
    await page.getByRole('button', { name: 'История' }).click();
    await expect(log).toBeVisible();

    // В чате — та же вкладка.
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('привет');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible();
    const gitRail = page.getByRole('navigation', { name: 'Вкладки панели' }).getByRole('button', { name: 'Git' });
    await gitRail.hover();
    await expect(page.getByRole('tooltip', { name: 'Git', exact: true })).toBeVisible();
    await gitRail.click();
    const sideLog = page.locator('.chat-side').getByRole('list', { name: 'История коммитов' });
    await expect(sideLog.getByRole('listitem')).toHaveCount(4);

    // «Ревью» у коммита — новая задача сразу в режиме ревью кода с этим коммитом.
    await sideLog.getByRole('listitem').filter({ hasText: 'Правка в main' }).click();
    await page.getByRole('button', { name: 'Ревью', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Ревью кода', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radiogroup', { name: 'Что проверить' }).getByRole('radio', { name: 'Коммит' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Коммит' }).last()).toContainText('Правка в main');
    await expect(page.getByRole('button', { name: 'Запустить прогон' })).toBeEnabled();
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: уровень рассуждений рядом с моделью уходит claude флагом --effort', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const effort = page.getByRole('button', { name: 'Уровень рассуждений' });
    // По умолчанию — как в CLI: флаг не передаётся.
    await expect(effort).toContainText('как в CLI');
    await effort.click();
    await page.getByRole('option', { name: /^high/ }).click();
    await expect(effort).toContainText('high');
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-effort.png') });

    const input = page.locator('.chat-compose textarea');
    await input.fill('подумай');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-user')).toContainText('подумай');
    await expect.poll(() => box.calls().at(-1)?.args.join(' ') ?? '').toContain('--effort high');

    // В настройках — тот же выбор у каждой роли на claude.
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('tab', { name: 'Модели' }).click();
    await expect(page.getByRole('button', { name: 'Уровень рассуждений: Исполнитель' })).toContainText('как в CLI');
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('проект: кнопка «Чат» открывает новый чат с этим проектом, а на «Обзоре» — чаты проекта', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Проекты' }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    // Проект уже выбран — не нужно искать его в списке.
    await expect(page.getByRole('button', { name: 'Проект', exact: true })).toContainText('demo');
    await expect(page.getByRole('heading', { name: /Спросите о demo/ })).toBeVisible();

    const input = page.locator('.chat-compose textarea');
    await input.fill('что тут?');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-user')).toContainText('что тут?');

    await page.getByRole('button', { name: 'Проекты' }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    // Чаты проекта — на вкладке «Статистика».
    await page.getByRole('tab', { name: 'Статистика' }).click();
    const chats = page.locator('.overview-chats');
    await expect(chats.getByRole('button')).toHaveCount(1);
    await chats.getByRole('button').click();
    await expect(page.locator('.chat-msg.is-user')).toContainText('что тут?');
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('боковая панель: «Проекты» раскрывает последние проекты и «Все проекты»', async () => {
  const box = makeSandbox();
  // Подключённый проект — как после настройки команд.
  fs.mkdirSync(path.join(box.profile, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(box.profile, 'data', 'projects.json'),
    JSON.stringify({
      [box.repo]: {
        setupCommand: '',
        lintCommand: '',
        testCommand: '',
        notes: { setup: '', lint: '', test: '' },
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  const l = await launch(box);
  const { page } = l;
  try {
    const projects = page.getByRole('button', { name: 'Проекты', exact: true });
    await expect(projects).toHaveAttribute('aria-haspopup', 'menu');
    await projects.click();
    const menu = page.getByRole('menu', { name: 'Последние проекты' });
    await menu.getByRole('menuitem', { name: /demo/ }).click();
    await expect(page.getByRole('tab', { name: 'Обзор' })).toBeVisible();
    await expect(menu).toHaveCount(0);
    if (process.env.PURPLEFLOW_SHOTS) {
      await projects.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-side-projects.png') });
      await page.locator('.side-create-scrim').click();
    }

    await projects.click();
    await menu.getByRole('menuitem', { name: 'Все проекты' }).click();
    // На экране проектов «Открыть папку…» бывает и в шапке, и в пустом списке.
    await expect(page.getByRole('button', { name: 'Открыть папку…' }).first()).toBeVisible();
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: «Указать элемент» в браузере вставляет чип элемента, агенту уходит его описание', async () => {
  const page0 = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
    <main><section class="hero"><a class="btn btn-primary" href="/signup" style="display:inline-block;margin:120px;padding:20px 40px;background:#fcc">Создать</a></section></main>
    <script>document.querySelector('a').addEventListener('click', () => { document.title = 'clicked'; });</script>
  </body></html>`;
  const server = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page0));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('Привет');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('navigation', { name: 'Вкладки панели' }).getByRole('button', { name: 'Браузер' }).click();
    const side = page.getByRole('region', { name: 'Код и браузер' });
    await side.getByLabel('Адрес').fill(`127.0.0.1:${port}`);
    await side.getByRole('button', { name: 'Открыть адрес' }).click();
    const view = side.locator('webview');
    await expect(view).toBeVisible();
    // Ждём, пока страница внутри webview загрузится.
    await expect
      .poll(() => view.evaluate((w: Electron.WebviewTag) => !w.isLoading() && w.getURL()), { timeout: 15_000 })
      .toContain(String(port));

    await input.fill('Сделай кнопку синей');
    await side.getByRole('button', { name: 'Указать элемент' }).click();
    await expect(side.getByText(/Наведите на элемент/)).toBeVisible();
    // Кнопка на странице — с отступом 120 px от угла webview; клик выбирает её, а не нажимает.
    const vb = (await view.boundingBox())!;
    await page.mouse.move(vb.x + 150, vb.y + 140);
    await page.mouse.move(vb.x + 160, vb.y + 145);
    await page.mouse.click(vb.x + 160, vb.y + 145);

    // В поле — короткий чип элемента, курсор после него: можно дописать просьбу.
    await expect(input).toHaveValue('Сделай кнопку синей ⌖a «Создать» ');
    await expect(page.locator('.compose-chip.is-pick')).toHaveText('⌖a «Создать»');
    await expect(side.getByText(/Наведите на элемент/)).toBeHidden();
    // Клик ушёл в выбор, а не в обработчик страницы.
    expect(await view.evaluate((w: Electron.WebviewTag) => w.getTitle())).not.toBe('clicked');
    // Агенту — полное описание элемента; в пузыре сообщения — только чип.
    await input.press('Enter');
    await expect.poll(() => box.calls().at(-1)?.prompt ?? '').toContain('— Элементы со страницы —');
    const prompt = box.calls().at(-1)!.prompt;
    expect(prompt).toMatch(/Элемент на странице 127\.0\.0\.1:\d+: <a\.btn\.btn-primary> «Создать»/);
    expect(prompt).toContain('- селектор: main > section.hero > a.btn.btn-primary');
    expect(prompt).toContain('- ссылка: /signup');
    const bubble = page.locator('.chat-msg.is-user').last();
    await expect(bubble.locator('.msg-chip.is-pick')).toHaveText('⌖a «Создать»');
    await expect(bubble).not.toContainText('Элементы со страницы');
  } finally {
    await quit(l);
    box.cleanup();
    server.close();
  }
});

test('чат: вкладка «Запуск» — старт, вывод сервера, браузер и стоп без просьб агенту', async () => {
  const box = makeSandbox();
  fs.writeFileSync(
    path.join(box.repo, 'server.cjs'),
    "const http = require('http');\nconsole.log('сервер стартует');\nhttp.createServer((q, s) => { console.log('запрос ' + q.url); s.end('<h1>demo app</h1>'); }).listen(process.env.PORT, '127.0.0.1');\n",
  );
  const l = await launch(box);
  const { page } = l;
  try {
    await page.evaluate(
      (repo) =>
        (
          window as unknown as { purpleflow: { core: { saveProjectConfig(dir: string, cfg: object): Promise<unknown> } } }
        ).purpleflow.core.saveProjectConfig(repo, {
          setupCommand: '',
          lintCommand: '',
          testCommand: '',
          runCommand: 'node server.cjs',
          appUrl: 'http://127.0.0.1:{port}/',
          notes: { setup: '', lint: '', test: '' },
        }),
      box.repo,
    );
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.getByRole('button', { name: 'Проект', exact: true }).click();
    await page.getByRole('option', { name: /Выбрать папку/ }).click();
    await page.locator('.chat-compose textarea').fill('Привет');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible({ timeout: 30_000 });

    const side = page.getByRole('region', { name: 'Код и браузер' });
    const toRun = () => page.getByRole('navigation', { name: 'Вкладки панели' }).getByRole('button', { name: 'Запуск приложения' }).click();
    await toRun();
    await expect(side.getByRole('status')).toHaveText('Не запущено');
    await expect(side.getByText('node server.cjs')).toBeVisible();

    await side.getByRole('button', { name: 'Запустить' }).click();
    await expect(side.getByRole('status')).toHaveText('Работает', { timeout: 30_000 });
    await expect(side.getByLabel('Вывод сервера')).toContainText('сервер стартует');
    const url = (await side.locator('.chat-run-code').nth(1).textContent())!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(url)).text()).toContain('demo app');
    // Вывод обновляется, пока сервер работает.
    await expect(side.getByLabel('Вывод сервера')).toContainText('запрос /');

    await side.getByRole('button', { name: 'В браузере' }).click();
    await expect(side.locator('webview')).toBeVisible();
    await toRun();
    await side.getByRole('button', { name: 'Остановить', exact: true }).click();
    await expect(side.getByRole('status')).toHaveText('Не запущено');
    await expect
      .poll(() =>
        fetch(url).then(
          () => 'up',
          () => 'down',
        ),
      )
      .toBe('down');
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат на agy в «Правках»: агент просит разрешение — карточка с командой, ответ уходит агенту', async () => {
  const pre = makeSandbox();
  const agyLog = path.join(pre.root, 'agy.jsonl');
  const agy = path.join(pre.root, 'bin', 'agy');
  fs.writeFileSync(agy, `#!/bin/sh\nFAKE_AGY_LOG="${agyLog}" exec "${process.execPath}" "${path.join(__dirname, 'fake-agy.mjs')}" "$@"\n`, {
    mode: 0o755,
  });
  const settingsFile = path.join(pre.profile, 'settings.json');
  const cur = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      ...cur,
      toolPaths: { ...cur.toolPaths, agy },
      enabledAgents: ['claude', 'agy'],
      agents: { ...cur.agents, executor: 'agy' },
    }),
  );
  const l = await launch(pre);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('Отправь ветку');
    await input.press('Enter');

    const card = page.getByRole('group', { name: 'Агент просит разрешение' });
    await expect(card).toBeVisible();
    await expect(card.locator('.chat-permission-cmd')).toHaveText('git push origin main');
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(pre.root, '..', 'pf-chat-permission.png') });
    }
    await card.getByRole('button', { name: 'Разрешать в этом чате' }).click();
    const answer = page.locator('.chat-msg.is-assistant').last();
    await expect(answer).toContainText('Отправил ветку.');
    await expect(answer.locator('.chat-permission-done')).toContainText('Разрешено в этом чате');
    await expect(card).toHaveCount(0);
    // Разрешение — не отказ песочницы: карточки полного доступа нет.
    await expect(page.getByRole('button', { name: 'Дать доступ и повторить' })).toHaveCount(0);
    const answers = fs
      .readFileSync(agyLog, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    expect(answers.at(-1).answer.outcome.optionId).toBe('allow');
  } finally {
    await quit(l);
    pre.cleanup();
  }
});

test('чат: папка в контексте — значок над полем, агенту путь и --add-dir; папку можно убрать', async () => {
  const box = makeSandbox();
  const docs = path.join(box.root, 'docs');
  fs.mkdirSync(docs);
  const l = await launch(box);
  const { page } = l;
  try {
    await l.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, docs);
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.getByRole('button', { name: 'Добавить папку в контекст' }).click();
    const chip = page.locator('.chat-file.is-dir');
    await expect(chip).toHaveText('docs');
    await expect(chip).toHaveAttribute('title', docs);
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-dir.png') });

    const input = page.locator('.chat-compose textarea');
    await input.fill('Что в документации?');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant').last()).not.toBeEmpty();
    const call = box.calls().find((c) => /Что в документации/.test(c.prompt))!;
    expect(call.prompt).toContain(`- ${docs}`);
    expect(call.args.join(' ')).toContain(`--add-dir ${docs}`);
    // Папка остаётся в чате и после отправки; убрать — кнопкой на значке.
    await expect(chip).toBeVisible();
    await page.getByRole('button', { name: 'Убрать папку docs из контекста' }).click();
    await expect(chip).toHaveCount(0);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('боковая панель: «Все · Чаты · Задачи» фильтруют историю, выбор запоминается', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('фильтр истории');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible({ timeout: 30_000 });

    const history = page.getByRole('navigation', { name: 'История' });
    const filter = page.locator('.side-filter');
    await expect(filter.getByRole('tab', { name: 'Все' })).toHaveAttribute('aria-selected', 'true');
    await expect(history).toContainText('фильтр истории');
    await filter.getByRole('tab', { name: 'Задачи' }).click();
    await expect(history).toContainText('Задач пока нет.');
    await expect(history).not.toContainText('фильтр истории');
    await filter.getByRole('tab', { name: 'Чаты' }).click();
    await expect(history).toContainText('фильтр истории');
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-side-filter.png') });
    }
    // После перезапуска окна — та же вкладка.
    await page.reload();
    await expect(page.locator('.side-filter').getByRole('tab', { name: 'Чаты' })).toHaveAttribute('aria-selected', 'true');
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});
