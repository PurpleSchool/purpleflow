// Сквозные сценарии: настоящее окно, настоящее ядро и git, фейковый только claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { PurpleFlowBridge } from '../src/shared/ipc';
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

/** Окно открывается на главном экране — оттуда к форме задачи. */
async function toNewTask(page: Page) {
  const card = page.getByRole('button', { name: /^Создать задачу/ });
  if (await card.isVisible()) await card.click();
}

async function fillRun(page: Page, mode: string, task: string) {
  await toNewTask(page);
  await page.getByRole('button', { name: /Выберите проект/ }).click();
  await page.getByRole('menuitem', { name: /Новый проект/ }).click();
  await expect(page.getByRole('button', { name: /demo/ }).first()).toBeVisible();
  await page.getByRole('radio', { name: mode, exact: true }).click();
  await page.locator('#task').fill(task);
}

async function startRun(page: Page, mode: string, task: string) {
  await fillRun(page, mode, task);
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

test('быстрые повторные сочетания запускают только один прогон', async () => {
  const { page } = l;
  const task = page.locator('#task');
  await fillRun(page, 'Быстрая правка', 'Не запускай эту задачу');
  await task.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true });
  const description = 'Добавь функцию mul в src/math.js';
  await task.fill(description);
  await expect(page.getByRole('button', { name: 'Запустить прогон' })).toBeEnabled();
  await task.evaluate((element) => {
    const shortcut = { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', shortcut));
    element.dispatchEvent(new KeyboardEvent('keydown', shortcut));
  });
  await expect(accept(page).first()).toBeVisible();
  const runs = await page.evaluate(() => (window as unknown as { purpleflow: PurpleFlowBridge }).purpleflow.core.listRuns());
  expect(runs.map((run) => run.title)).toEqual([description]);
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

test('приёмка: набранное замечание переживает уход в настройки и возврат к прогону', async () => {
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await expect(accept(l.page)).toBeVisible({ timeout: 60_000 });
  await l.page.getByRole('button', { name: 'Есть замечания' }).click();
  await l.page.locator('.gate-comment').fill('Назови функцию multiply');
  await l.page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(l.page.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
  await l.page.getByText('Добавь функцию mul', { exact: false }).first().click();
  await expect(l.page.locator('.gate-comment')).toHaveValue('Назови функцию multiply');
});

test('приёмка: дифф показывает изменение, возврат с него не роняет страницу', async () => {
  // Окно — как при обычном запуске: на маленьком экране оно ужимается, панель вкладок сразу тесная,
  // и сравнение «узко → прежняя ширина» проверяло бы не то.
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  // На приёмке дифф открывается сам.
  await expect(l.page.getByRole('button', { name: 'math.js' })).toBeVisible({ timeout: 60_000 });
  await expect(l.page.locator('.monaco-diff-editor').getByText('mul', { exact: false }).first()).toBeVisible();
  await l.page.getByRole('tab', { name: 'Таймлайн' }).click();
  await expect(l.page.locator('.monaco-diff-editor')).toHaveCount(0);
  await l.page.getByRole('tab', { name: /^Код/ }).first().click();
  await expect(l.page.locator('.monaco-diff-editor').getByText('mul', { exact: false }).first()).toBeVisible();
  // Узкое окно: вкладки прогона сжимаются до иконок, все остаются в строке.
  const size = await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  const runTabs = l.page.locator('.run-main .tab-groups > .tabs');
  const before = (await runTabs.getAttribute('class'))!;
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
  await expect(runTabs).toHaveClass(/is-compact/);
  // Кнопка «Обновить» рядом с вкладками остаётся целиком внутри карточки.
  const refresh = l.page.locator('.tab-tools').getByRole('button', { name: 'Обновить' });
  await expect
    .poll(async () => {
      const card = (await l.page.locator('.run-main').boundingBox())!;
      const b = (await refresh.boundingBox())!;
      return b.x + b.width <= card.x + card.width;
    })
    .toBe(true);
  if (process.env.PURPLEFLOW_SHOTS) {
    await l.page.waitForTimeout(600);
    await l.page.screenshot({ path: path.join(os.tmpdir(), 'pf-run-narrow.png') });
  }
  await l.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size);
  // Прежняя ширина — прежний вид вкладок.
  await expect(runTabs).toHaveAttribute('class', before);
  await expect(refresh).toContainText('Обновить');
  await expect(l.page.locator('.code-at')).toBeVisible();
});

test('приёмка: клавиши ревью не срабатывают при поиске в диффе', async () => {
  const { page } = l;
  await startRun(page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await expect(accept(page).first()).toBeEnabled();
  const viewed = page.getByRole('button', { name: 'Просмотрено', exact: true });
  await expect(viewed).toHaveAttribute('title', /Отметить просмотренным/);

  const editor = page.locator('.monaco-diff-editor .modified .view-lines');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await editor.click();
  await page.keyboard.press(`${mod}+f`);
  const find = page.getByRole('textbox', { name: 'Find', exact: true });
  await expect(find).toBeFocused();
  await find.fill('');
  await page.keyboard.press('v');
  await expect(find).toHaveValue('v');
  await expect(viewed).toHaveAttribute('title', /Отметить просмотренным/);

  const status = () =>
    page.evaluate(async () => (await (window as unknown as { purpleflow: PurpleFlowBridge }).purpleflow.core.listRuns())[0]?.status);
  await page.keyboard.press(`${mod}+Enter`);
  expect(await status()).toBe('waiting');
  await expect(accept(page).first()).toBeEnabled();

  await page.keyboard.press('Escape');
  await editor.click();
  await page.keyboard.press('v');
  await expect(viewed).toHaveAttribute('title', 'Снять отметку');
  await page.keyboard.press(`${mod}+Enter`);
  await expect.poll(status).toBe('finished');
});

test('прогон: «Файлы» — рабочая копия агента, «Git» — ветка прогона с названием задачи', async () => {
  const page = l.page;
  await startRun(page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await expect(accept(page)).toBeVisible({ timeout: 60_000 });

  // Файлы — из рабочей копии прогона: правка агента видна, хотя в проекте её нет. Только просмотр — без «+».
  await page.getByRole('tab', { name: 'Файлы' }).click();
  await page.getByRole('textbox', { name: 'Найти файл' }).fill('math');
  const hit = page.getByRole('list', { name: 'Найденные файлы' }).getByRole('listitem', { name: 'src/math.js' });
  await expect(hit.getByRole('button', { name: /Добавить в контекст/ })).toHaveCount(0);
  await hit.getByRole('button', { name: 'src/math.js', exact: true }).click();
  await expect(page.locator('.chat-file-view')).toContainText('mul');

  // Git — ветка прогона подсвечена, в списке веток подписана задачей.
  await page.getByRole('tab', { name: 'Git' }).click();
  await expect(page.locator('.git-row.is-marked')).toBeVisible();
  await page.getByRole('button', { name: /веток: 2/ }).click();
  if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-run-git.png') });
  await expect(page.getByRole('list', { name: 'Ветки' }).getByRole('listitem').filter({ hasText: 'purpleflow/' })).toContainText(
    'Добавь функцию mul',
  );
});

test('менеджер прогона отвечает на вопрос', async () => {
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await expect(accept(l.page)).toBeVisible({ timeout: 60_000 });
  await l.page.getByRole('button', { name: 'Как идут дела?' }).click();
  await expect(l.page.getByText('Всё идёт по плану.').first()).toBeVisible({ timeout: 60_000 });
});

test('менеджеру можно приложить скриншот: превью в поле, картинка в сообщении', async () => {
  await startRun(l.page, 'Быстрая правка', 'Добавь функцию mul в src/math.js');
  await expect(accept(l.page)).toBeVisible({ timeout: 60_000 });
  // Однопиксельный PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await l.page.locator('.manager-compose input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
  await expect(l.page.locator('.manager-images img')).toHaveCount(1);
  await l.page.locator('.manager-compose textarea').fill('Что на скриншоте?');
  await l.page.getByRole('button', { name: 'Отправить' }).click();
  await expect(l.page.locator('.msg-user .msg-images img')).toHaveAttribute('src', /^data:image\/png/);
  await expect(l.page.locator('.manager-images')).toHaveCount(0);
  await expect(l.page.getByText('Всё идёт по плану.').first()).toBeVisible({ timeout: 60_000 });
  const prompt = box.calls().find((c) => /Ты — менеджер прогона/.test(c.prompt))!.prompt;
  expect(prompt).toMatch(/Изображения от человека[\s\S]*shot\.png/);
});

test('запуск: инструменты найдены, настройки открываются', async () => {
  await expect(l.page.getByTitle(/bin\/claude 2\.0\.0/)).toBeVisible();
  await l.page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(l.page.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
});

test('подпапка чужого репозитория: прогон не уходит в его корень, предлагается корень', async () => {
  // Новый проект внутри уже подключённого: раньше задача молча запускалась в корне внешнего репозитория.
  const sub = path.join(box.repo, 'packages/web');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'package.json'), '{"name":"web"}');
  await l.app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, sub);
  await toNewTask(l.page);
  await l.page.getByRole('button', { name: /Выберите проект/ }).click();
  await l.page.getByRole('menuitem', { name: /Новый проект/ }).click();
  await expect(l.page.getByText(/Папка лежит внутри репозитория/)).toBeVisible();
  await l.page.locator('#task').fill('Добавь страницу в packages/web');
  await expect(l.page.getByRole('button', { name: 'Запустить прогон' })).toBeDisabled();
  await l.page.getByRole('button', { name: 'возьмите корень репозитория' }).click();
  await expect(l.page.getByText(/Папка лежит внутри репозитория/)).toHaveCount(0);
  await expect(l.page.getByRole('button', { name: /demo/ }).first()).toBeVisible();
  await expect(l.page.getByRole('button', { name: 'Запустить прогон' })).toBeEnabled();
});

test('ревью по кругу: стоп раньше лимита, уточнение человека доходит до ревьюера', async () => {
  await startRun(l.page, 'Задача', 'Добавь умножение в калькулятор РЕВЬЮ_ПО_КРУГУ');
  await accept(l.page, /^Принять план/).click();
  // Первое ревью — замечание, вторая попытка, повторное ревью — то же самое: стоп, хотя третья попытка ещё есть.
  await expect(l.page.getByText('Ходят по кругу', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(l.page.getByRole('list', { name: 'Замечания, которые не сдвинулись' })).toContainText('mul не проверяет аргументы');
  await l.page.locator('.gate-comment').fill('Проверка аргументов не нужна, mul — внутренняя функция');
  await l.page.getByRole('button', { name: /Уточнить и ещё попытка/ }).click();
  await accept(l.page).click();
  await expect.poll(() => resultOnBranch().math).toContain('mul');
  const reviews = box.calls().filter((c) => /ревьюер в конвейере PurpleFlow/.test(c.prompt));
  expect(reviews.at(-1)!.prompt).toContain('внутренняя функция');
});

test('настройки: числовое поле можно стереть и набрать заново; пустое при уходе — значение по умолчанию', async () => {
  await l.page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await l.page.locator('.settings-tabs').getByText('Модели', { exact: true }).click();
  const field = l.page.getByRole('spinbutton', { name: /Таймаут тестов/ });
  await field.fill('');
  await expect(field).toHaveValue('');
  await field.pressSequentially('25');
  await expect(field).toHaveValue('25');
  const parallel = l.page.getByRole('spinbutton', { name: /Одновременно прогонов/ });
  await parallel.fill('');
  await parallel.blur();
  await expect(parallel).toHaveValue('2');
  await parallel.fill('12');
  await parallel.blur();
  await expect(parallel).toHaveValue('8');
});

test('длинное описание задачи раскрывается с прокруткой, шапка не уходит за край окна', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `Пункт ${i + 1}: добавь функцию mul в src/math.js`).join('\n');
  await startRun(l.page, 'Быстрая правка', long);
  await l.page.locator('.desc-toggle').click();
  const inner = l.page.locator('.desc.is-open .desc-inner');
  await expect(inner).toBeVisible();
  await expect
    .poll(() => inner.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'))
    .toBe(true);
  const viewport = l.page.viewportSize() ?? (await l.page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const box2 = await inner.boundingBox();
  expect(box2!.y + box2!.height).toBeLessThan(viewport.height);
  await inner.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(l.page.getByText('Пункт 120:', { exact: false })).toBeInViewport();
});

test('ревью кода: незакоммиченные правки — замечания на разбор, исправление уходит в чат, проект не тронут', async () => {
  const file = path.join(box.repo, 'src/math.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'export const sub = (a, b) => a + b;\n');
  const status = box.git('status', '--porcelain');
  const head = box.git('rev-parse', 'HEAD');
  const page = l.page;
  await toNewTask(page);
  await page.getByRole('button', { name: /Выберите проект/ }).click();
  await page.getByRole('menuitem', { name: /Новый проект/ }).click();
  await expect(page.getByRole('button', { name: /demo/ }).first()).toBeVisible();
  await page.getByRole('radio', { name: 'Ревью кода', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Что проверить' }).getByRole('radio', { name: 'Незакоммиченное' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Ни автопилота, ни выбора рабочей копии: ревью всегда только читает.
  await expect(page.getByRole('switch', { name: 'Автопилот' })).toHaveCount(0);
  if (process.env.PURPLEFLOW_SHOTS) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(box.root, '..', 'pf-review-form.png') });
  }
  await page.getByRole('button', { name: 'Запустить прогон' }).click();

  await expect(page.getByText('Разбор', { exact: true })).toBeVisible({ timeout: 60_000 });
  // Есть замечания — «Разбор» сразу открывает вкладку «Замечания», отдельного «Код / Заметки» больше нет.
  await expect(page.getByRole('tab', { name: /Замечания/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /^Заметки/ })).toHaveCount(0);
  await expect(page.locator('.note.n-blocking p')).toHaveText('sub складывает вместо вычитания');
  await expect(page.getByRole('heading', { name: /^Важные/ })).toBeVisible();
  if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-review-notes.png') });
  // Отправить на исправление можно только выбранное.
  const fix = page.getByRole('button', { name: /Исправить в чате/ });
  await expect(fix).toBeDisabled();
  await page.locator('.note.n-blocking').getByRole('switch').click();
  // Клик по месту замечания ведёт к строке во вкладке «Код».
  await page.locator('.note.n-blocking .note-loc').click();
  await expect(page.getByRole('tab', { name: /^Код/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /Замечания/ }).click();
  await fix.click();

  await expect(page.locator('.chat-compose textarea')).toHaveValue(/sub складывает вместо вычитания/);
  await expect(page.locator('.chat-compose textarea')).toHaveValue(/src\/math\.js:1/);
  expect(box.git('status', '--porcelain')).toBe(status);
  expect(box.git('rev-parse', 'HEAD')).toBe(head);
  expect(box.calls().some((c) => /ревьюер кода в PurpleFlow/.test(c.prompt) && c.prompt.includes('sub = (a, b) => a + b'))).toBe(true);
});
