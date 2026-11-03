// Установка инструментов из окна: настоящие процессы, вместо npm — сценарий во временном каталоге.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installTool } from './services/setup.js';

const skip = process.platform === 'win32';

/** Фейковый npm: кладёт исполняемый openspec в bin и пишет аргументы в лог; без --prefix поведение задаёт сценарий. */
function sandbox(t: { after: (fn: () => void) => void }, whenGlobal: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-setup-')));
  const home = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    process.env.HOME = home;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'npm.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh
echo "$*" >> "${log}"
tool() { mkdir -p "$1"; printf '#!/bin/sh\\necho 1.2.3\\n' > "$1/openspec"; chmod +x "$1/openspec"; }
case "$*" in
  *--prefix*) tool "$6/bin" ;;
  *) ${whenGlobal} ;;
esac
`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin` };
  return { env, bin, root, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

test('installTool: ставит зашитый пакет глобально и находит инструмент', { skip }, async (t) => {
  const s = sandbox(t, 'tool "$(dirname "$0")"');
  const r = await installTool('openspec', s.env);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info?.version, '1.2.3');
  assert.deepEqual(s.calls(), ['install --global --no-audit --no-fund @fission-ai/openspec']);
});

test('installTool: нет прав на глобальный каталог — ставит в домашний и дополняет PATH', { skip }, async (t) => {
  const s = sandbox(t, 'echo "npm error code EACCES" >&2; exit 243');
  const r = await installTool('openspec', s.env);
  assert.equal(r.ok, true, r.error);
  const home = path.join(s.root, '.npm-global');
  assert.equal(r.info?.path, path.join(home, 'bin', 'openspec'));
  assert.ok(s.env.PATH?.startsWith(path.join(home, 'bin')), 'следующий поиск должен найти инструмент без перезапуска');
  assert.equal(s.calls()[1], `install --global --no-audit --no-fund --prefix ${home} @fission-ai/openspec`);
});

test('installTool: сбой npm показывает причину и не считается успехом', { skip }, async (t) => {
  const s = sandbox(t, 'echo "npm error network timeout" >&2; exit 1');
  const r = await installTool('openspec', s.env);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /@fission-ai\/openspec.*network timeout/s);
  assert.equal(s.calls().length, 1, 'обычный сбой не повод ставить в другой каталог');
});

test('installTool: npm отработал, но инструмента нет в PATH — это ошибка', { skip }, async (t) => {
  const s = sandbox(t, 'exit 0');
  const r = await installTool('openspec', s.env);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /не найден в PATH/);
});

test('installTool: каталог npm появился только сейчас — находит инструмент через npm prefix', { skip }, async (t) => {
  const s = sandbox(t, `if [ "$1" = prefix ]; then echo "$(dirname "$0")/../fresh"; else tool "$(dirname "$0")/../fresh/bin"; fi`);
  const r = await installTool('openspec', s.env);
  assert.equal(r.ok, true, r.error);
  assert.match(r.info?.path ?? '', /fresh\/bin\/openspec$/);
});

test('installTool: путь вручную и git не запускают npm', { skip }, async (t) => {
  const s = sandbox(t, 'exit 0');
  const manual = await installTool('openspec', s.env, '/где/то/openspec');
  assert.match(manual.error ?? '', /путь вручную/);
  const git = await installTool('git', s.env);
  assert.equal(git.ok, false);
  assert.ok(git.error);
  assert.equal(fs.existsSync(path.join(s.root, 'npm.log')), false);
});

test('installTool: без npm просит поставить Node.js', async () => {
  const r = await installTool('codex', { PATH: '' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Node\.js/);
});
