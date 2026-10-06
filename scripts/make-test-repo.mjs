#!/usr/bin/env node
// Создаёт git-репозиторий из шаблона test-repo/ в указанной папке (по умолчанию ~/psflow-sample).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'psflow-sample'));
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  console.error(`Папка ${target} не пуста`);
  process.exit(1);
}
fs.cpSync(path.join(root, 'test-repo'), target, { recursive: true });
fs.renameSync(path.join(target, 'gitignore.txt'), path.join(target, '.gitignore'));
const git = (...args) => execFileSync('git', args, { cwd: target, stdio: 'inherit' });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=PS Flow', '-c', 'user.email=psflow@localhost', 'commit', '-q', '-m', 'Initial commit');
console.log(`Готово: ${target}`);
