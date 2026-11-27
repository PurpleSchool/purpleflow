// Первый запуск: окно настройки после экрана входа. Настоящую установку не запускаем: сломанный путь останавливает её до npm.
import fs from 'node:fs';
import path from 'node:path';
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

test('выключенный codex не нужен: строка пропадает, роли переходят на claude', async () => {
  await start({
    authPrompted: true,
    agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
    toolPaths: { codex: '/нет/такого/codex' },
  });

  const dialog = l.page.getByRole('dialog', { name: 'Подготовим окружение' });
  await expect(dialog.getByRole('button', { name: 'Настроить' })).toBeVisible();
  await dialog.getByRole('switch', { name: 'Codex CLI' }).click();
  await expect(dialog.getByRole('switch', { name: 'Codex CLI' })).toHaveAttribute('aria-checked', 'false');
  // Последний включённый агент выключить нельзя.
  await expect(dialog.getByRole('switch', { name: 'Claude Code' })).toBeDisabled();
  await expect(dialog.getByText('Codex CLI', { exact: true })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Готово, к задаче' })).toBeVisible();
  if (process.env.PURPLEFLOW_SHOTS) await dialog.screenshot({ path: path.join(box.root, '..', 'pf-agents-dialog.png') });

  await dialog.getByRole('button', { name: 'Позже' }).click();
  const saved = JSON.parse(fs.readFileSync(path.join(box.profile, 'settings.json'), 'utf8'));
  expect(saved.enabledAgents).toEqual(['claude']);
  expect(saved.agents.reviewer).toBe('claude');
  expect(saved.models.reviewer).toBe('opus');

  await l.page.locator('.settings-tabs').getByText('Модели', { exact: true }).click();
  await expect(l.page.getByRole('heading', { name: 'Агенты и модели по ролям' })).toBeVisible();
  await expect(l.page.getByRole('radio', { name: 'codex' })).toHaveCount(0);
});

test('проект с нуля: папка без git — «Создать репозиторий» делает main, .gitignore и первый коммит', async () => {
  await start({ onboarded: true });
  const dir = path.join(box.root, 'fresh');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  await l.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog;
  }, dir);
  await l.page.getByRole('button', { name: 'Как начать?' }).click();
  await l.page.getByRole('button', { name: 'Выбрать папку…' }).click();
  await expect(l.page.getByText('Папка ещё не git-репозиторий')).toBeVisible();
  await l.page.getByRole('button', { name: 'Создать репозиторий' }).click();
  await expect(l.page.getByRole('button', { name: 'Создать репозиторий' })).toHaveCount(0);
  await expect(l.page.getByText('Папка ещё не git-репозиторий')).toHaveCount(0);
  const git = (...a: string[]) => box.git('-C', dir, ...a);
  expect(git('branch', '--show-current')).toBe('main');
  expect(git('ls-files').split('\n').sort()).toEqual(['.gitignore', 'index.js']);
});

test('«Сообщить о проблеме» рядом с настройками открывает issue на GitHub с версией и окружением', async () => {
  await start({ onboarded: true });
  // Настоящий браузер не открываем — запоминаем адрес.
  await l.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = (async (url: string) => void g.opened.push(url)) as typeof shell.openExternal;
  });
  await expect(l.page.locator('.side-tools .tool-chip.is-ok', { hasText: 'claude' })).toBeVisible();
  const bug = l.page.getByRole('button', { name: 'Сообщить о проблеме' });
  await bug.hover();
  await expect(bug.getByRole('tooltip')).toHaveCSS('opacity', '1');
  if (process.env.PF_SHOT) await l.page.locator('.side').screenshot({ path: process.env.PF_SHOT });
  await l.page.getByRole('button', { name: 'Сообщить о проблеме' }).click();
  await expect.poll(() => l.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened.length)).toBe(1);
  const url = new URL(await l.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened[0]));
  expect(`${url.origin}${url.pathname}`).toBe('https://github.com/PurpleSchool/purpleflow/issues/new');
  const body = url.searchParams.get('body')!;
  expect(body).toMatch(/- PurpleFlow: \d+\.\d+\.\d+/);
  expect(body).toMatch(/- claude: 2\.0\.0/);
  // Ни путей, ни папки профиля в отчёте.
  expect(body).not.toContain(box.root);
});

test('без входа слева от формы — баннер стартового баланса, его кнопка переключает форму на регистрацию', async () => {
  await start({ onboarded: true });
  await l.page.getByRole('button', { name: 'Настройки' }).click();
  await expect(l.page.getByRole('heading', { name: 'Вход в PurpleSchool' })).toBeVisible();
  const banner = l.page.getByRole('region', { name: 'Стартовый баланс' });
  await expect(banner).toContainText('500 000');
  if (process.env.PF_SHOT) await l.page.locator('.acc-signin').screenshot({ path: process.env.PF_SHOT });
  await banner.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(l.page.getByRole('heading', { name: 'Регистрация в PurpleSchool' })).toBeVisible();
});

test('«Новый проект» с главной: мастер — папка, сканирование начинается само, «Открыть чат» подключает проект', async () => {
  await start({ onboarded: true });
  await l.app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [repo] })) as typeof dialog.showOpenDialog;
  }, box.repo);
  await l.page
    .getByRole('button', { name: /Новый проект/ })
    .first()
    .click();
  await expect(l.page.getByRole('heading', { name: 'Новый проект' })).toBeVisible();
  await l.page.getByRole('button', { name: 'Выбрать папку…' }).click();
  await expect(l.page.getByText('demo', { exact: true })).toBeVisible();
  // Сканирование — само, без кнопки «Сканировать проект».
  await expect(l.page.locator('.fp-scan-row').first()).not.toHaveClass(/is-idle/);
  await expect(l.page.getByRole('button', { name: 'Сканировать проект' })).toHaveCount(0);
  await l.page.getByRole('button', { name: 'Открыть чат' }).click();
  await expect(l.page.locator('.chat-compose textarea')).toBeVisible();
  // Проект подключён: в списке проектов и в меню «Проекты».
  await l.page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await expect(l.page.getByRole('menu', { name: 'Последние проекты' })).toContainText('demo');
  await expect(l.page.getByRole('menuitem', { name: 'Новый проект' })).toBeVisible();
});
