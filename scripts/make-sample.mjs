#!/usr/bin/env node
// Создаёт git-репозиторий из шаблона в указанной папке (по умолчанию ~/purpleflow-sample).
// --web — веб-приложение для визуальной проверки (шаблон examples/sample-web/).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const web = args.includes('--web');
const target = path.resolve(
  args.find((a) => !a.startsWith('--')) ?? path.join(os.homedir(), web ? 'purpleflow-sample-web' : 'purpleflow-sample'),
);
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  console.error(`Папка ${target} не пуста`);
  process.exit(1);
}
fs.cpSync(path.join(root, 'examples', web ? 'sample-web' : 'sample-ts'), target, { recursive: true });
fs.renameSync(path.join(target, 'gitignore.txt'), path.join(target, '.gitignore'));
const git = (...args) => execFileSync('git', args, { cwd: target, stdio: 'inherit' });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=PurpleFlow', '-c', 'user.email=purpleflow@localhost', 'commit', '-q', '-m', 'Initial commit');
console.log(`Готово: ${target}`);
