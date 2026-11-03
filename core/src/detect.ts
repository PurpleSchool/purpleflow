import fs from 'node:fs';
import path from 'node:path';

import type { CommandIssue, ProjectCommands } from './types.js';

/** Команда тестов и подготовки по файлам проекта: package.json / go.mod / pyproject.toml / Cargo.toml. */
export function detectProjectCommands(dir: string): ProjectCommands {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object; packageManager?: string } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      /* битый package.json — всё равно предлагаем npm test */
    }
    const pm =
      has('pnpm-lock.yaml') || pkg.packageManager?.startsWith('pnpm')
        ? 'pnpm'
        : has('yarn.lock')
          ? 'yarn'
          : has('bun.lockb') || has('bun.lock')
            ? 'bun'
            : 'npm';
    const hasDeps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
    const install = pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`;
    const test = pkg.scripts?.test ? (pm === 'npm' ? 'npm test' : `${pm} test`) : '';
    const lintScript = ['lint', 'eslint', 'check'].find((k) => pkg.scripts?.[k]);
    const lint = lintScript ? (pm === 'npm' ? `npm run ${lintScript}` : `${pm} run ${lintScript}`) : '';
    return { testCommand: test, setupCommand: hasDeps ? install : '', lintCommand: lint, detectedFrom: 'package.json' };
  }
  if (has('go.mod')) return { testCommand: 'go test ./...', setupCommand: '', lintCommand: 'go vet ./...', detectedFrom: 'go.mod' };
  if (has('pyproject.toml')) {
    const text = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
    const lintCommand = text.includes('[tool.ruff') ? 'ruff check .' : '';
    if (text.includes('[tool.poetry'))
      return {
        testCommand: 'poetry run pytest',
        setupCommand: 'poetry install',
        lintCommand: lintCommand && `poetry run ${lintCommand}`,
        detectedFrom: 'pyproject.toml',
      };
    if (has('uv.lock'))
      return {
        testCommand: 'uv run pytest',
        setupCommand: 'uv sync',
        lintCommand: lintCommand && `uv run ${lintCommand}`,
        detectedFrom: 'pyproject.toml',
      };
    return { testCommand: 'python -m pytest', setupCommand: '', lintCommand, detectedFrom: 'pyproject.toml' };
  }
  if (has('Cargo.toml'))
    return { testCommand: 'cargo test', setupCommand: '', lintCommand: 'cargo clippy -- -D warnings', detectedFrom: 'Cargo.toml' };
  return { testCommand: '', setupCommand: '', lintCommand: '', detectedFrom: null };
}

/**
 * Файлы окружения проекта (.env, .env.local, apps/api/.env…) — их нет в git, а значит и в worktree прогона.
 * Шаблоны (.env.example, .sample, .template) не берём: они и так в репозитории.
 */
export function findEnvFiles(repo: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const skip = new Set([
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    'coverage',
    '.turbo',
    'vendor',
    'target',
    '.venv',
    'venv',
    'openspec',
  ]);
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !skip.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (/^\.env(\..+)?$/.test(e.name) && !/\.(example|sample|template|dist)$/.test(e.name)) {
        out.push(path.relative(repo, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(repo, 0);
  return out.sort();
}

/**
 * Проверка команды без запуска: каждый `npm run X` / `pnpm X` / `yarn X` сверяется со scripts в package.json
 * той папки, куда ведут `cd` перед ним. Ловит «Missing script» до прогона.
 */
export function checkCommand(repo: string, command: string): CommandIssue[] {
  const issues: CommandIssue[] = [];
  let fixed = command;
  // Сегменты между && ; | & и скобками; cd внутри скобок действует до закрывающей скобки.
  const tokens = command.split(/(\(|\)|&&|\|\||;|\||&)/);
  const stack: string[] = [];
  let cwd = '.';
  for (const raw of tokens) {
    const t = raw.trim();
    if (t === '(') {
      stack.push(cwd);
      continue;
    }
    if (t === ')') {
      cwd = stack.pop() ?? '.';
      continue;
    }
    if (!t || /^(&&|\|\||;|\||&)$/.test(t)) continue;
    const words = t.split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
    if (words[0] === 'cd' && words[1]) {
      cwd = path.posix.normalize(path.posix.join(cwd, words[1].replace(/^["']|["']$/g, '')));
      continue;
    }
    let script: string | null = null;
    if (words[0] === 'npm' && (words[1] === 'run' || words[1] === 'run-script') && words[2]) script = words[2];
    else if (
      (words[0] === 'pnpm' || words[0] === 'yarn') &&
      words[1] &&
      !['install', 'add', 'exec', 'dlx', 'i', 'remove', 'run', 'workspace', 'workspaces'].includes(words[1])
    )
      script = words[1];
    else if ((words[0] === 'pnpm' || words[0] === 'yarn') && words[1] === 'run' && words[2]) script = words[2];
    // Флаг вместо имени («pnpm --filter web dev», «npm run -w web build») — какой пакет имеется в виду, отсюда не понять.
    if (!script || script.startsWith('-')) continue;
    const pkgFile = path.join(repo, cwd, 'package.json');
    let scripts: Record<string, string>;
    try {
      scripts = (JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      issues.push({ message: `Нет файла ${path.posix.join(cwd, 'package.json')} — проверьте путь в cd.` });
      continue;
    }
    if (scripts[script]) continue;
    const names = Object.keys(scripts);
    // Похожие: start:dev для dev, dev:server для dev и т. п.
    const similar = names.filter((n) => n.split(/[:\-_]/).includes(script!) || n.includes(script!));
    const where = cwd === '.' ? 'package.json' : `${cwd}/package.json`;
    const best = similar.length === 1 ? similar[0] : (similar.find((n) => n === `start:${script}`) ?? null);
    if (best)
      fixed = fixed.replace(
        new RegExp(`(\\b(?:npm run|pnpm|yarn)(?: run)?\\s+)${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s;&|)])`),
        `$1${best}`,
      );
    issues.push({
      message: `В ${where} нет скрипта «${script}».${similar.length ? ` Похожие: ${similar.join(', ')}.` : names.length ? ` Есть: ${names.slice(0, 8).join(', ')}.` : ''}`,
      fix: best && fixed !== command ? fixed : undefined,
    });
  }
  return issues;
}
