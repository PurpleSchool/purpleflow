// Обвязка сквозных тестов: настоящее окно из out/, отдельный профиль и фейковый claude вместо настоящего.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

// Playwright собирает тесты в CommonJS: пакет app не объявлен как модуль, import.meta здесь недоступен.
const HERE = __dirname;
const APP_DIR = path.dirname(HERE);
const ROOT = path.dirname(APP_DIR);

/** Что происходит в тестовом каталоге: профиль окна, репозиторий проекта, фейковые CLI. */
export interface Sandbox {
  root: string;
  profile: string;
  repo: string;
  git: (...args: string[]) => string;
  /** Промпты, с которыми окно вызывало фейковый claude. */
  calls: () => { args: string[]; prompt: string }[];
  cleanup: () => void;
}

export function makeSandbox(): Sandbox {
  // realpath: на macOS os.tmpdir() — симлинк, а git и окно отдают уже настоящий путь.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-')));
  const profile = path.join(root, 'profile');
  const repo = path.join(root, 'demo');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.jsonl');
  fs.mkdirSync(profile);
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);

  // Сценарий фейка — рядом с тестами. Через sh, потому что путь к node может содержать пробелы, а shebang их не умеет.
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(
    claude,
    `#!/bin/sh\nFAKE_CLAUDE_LOG="${log}" exec "${process.execPath}" "${path.join(HERE, 'fake-claude.mjs')}" "$@"\n`,
    {
      mode: 0o755,
    },
  );
  // Пути заданы явно: окружение ядра берётся из login shell, и без них запустился бы настоящий claude разработчика.
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({
      onboarded: true,
      authPrompted: true,
      toolPaths: { claude, openspec: path.join(ROOT, 'node_modules/.bin/openspec') },
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    }),
  );

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.test');
  git('config', 'user.name', 'E2E');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --version' } }, null, 2),
  );
  git('add', '-A');
  git('commit', '-qm', 'Начало');

  return {
    root,
    profile,
    repo,
    git,
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { args: string[]; prompt: string })
        : [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Окно приложения и ошибки страницы: необработанное исключение — повод уронить тест, даже если сценарий дошёл до конца. */
export interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

export async function launch(box: Sandbox): Promise<Launched> {
  const app = await electron.launch({
    cwd: APP_DIR,
    // В контейнере CI нет прав на песочницу Chromium.
    // «.», а не путь к файлу: от каталога приложения окно ищет промпты ядра, как и при обычном запуске.
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'],
    env: { ...process.env, PURPLEFLOW_USER_DATA: box.profile, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } as Record<string, string>,
  });
  // Системный диалог выбора папки автоматизировать нельзя — на его месте сразу ответ.
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [repo] })) as typeof dialog.showOpenDialog;
  }, box.repo);
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForLoadState('domcontentloaded');
  return { app, page, errors };
}

/** Закрыть окно и дождаться выхода: следующий запуск на том же профиле иначе упрётся в блокировку одного экземпляра. */
export async function quit(l: Launched) {
  await l.app.close();
}
