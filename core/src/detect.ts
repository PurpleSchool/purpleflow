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
    return { testCommand: test, setupCommand: hasDeps ? install : '', detectedFrom: 'package.json' };
  }
  if (has('go.mod')) return { testCommand: 'go test ./...', setupCommand: '', detectedFrom: 'go.mod' };
  if (has('pyproject.toml')) {
    const text = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
    if (text.includes('[tool.poetry')) return { testCommand: 'poetry run pytest', setupCommand: 'poetry install', detectedFrom: 'pyproject.toml' };
    if (has('uv.lock')) return { testCommand: 'uv run pytest', setupCommand: 'uv sync', detectedFrom: 'pyproject.toml' };
    return { testCommand: 'python -m pytest', setupCommand: '', detectedFrom: 'pyproject.toml' };
  }
  if (has('Cargo.toml')) return { testCommand: 'cargo test', setupCommand: '', detectedFrom: 'Cargo.toml' };
  return { testCommand: '', setupCommand: '', detectedFrom: null };
}
