import fs from 'node:fs';
import path from 'node:path';

import type { ProjectCommands } from './types.js';

/** Команда тестов и подготовки по файлам проекта: package.json / go.mod / pyproject.toml / Cargo.toml. */
export function detectProjectCommands(dir: string): ProjectCommands {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object; packageManager?: string } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch { /* битый package.json — всё равно предлагаем npm test */ }
    const pm = has('pnpm-lock.yaml') || pkg.packageManager?.startsWith('pnpm')
      ? 'pnpm'
      : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
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
    if (text.includes('[tool.poetry')) return { testCommand: 'poetry run pytest', setupCommand: 'poetry install', lintCommand: lintCommand && `poetry run ${lintCommand}`, detectedFrom: 'pyproject.toml' };
    if (has('uv.lock')) return { testCommand: 'uv run pytest', setupCommand: 'uv sync', lintCommand: lintCommand && `uv run ${lintCommand}`, detectedFrom: 'pyproject.toml' };
    return { testCommand: 'python -m pytest', setupCommand: '', lintCommand, detectedFrom: 'pyproject.toml' };
  }
  if (has('Cargo.toml')) return { testCommand: 'cargo test', setupCommand: '', lintCommand: 'cargo clippy -- -D warnings', detectedFrom: 'Cargo.toml' };
  return { testCommand: '', setupCommand: '', lintCommand: '', detectedFrom: null };
}
