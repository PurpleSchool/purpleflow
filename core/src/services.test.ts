// Сервисы, которым не нужен прогон конвейера: хранилище данных, вложения, чистка места.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkCommand, detectProjectCommands } from './detect.js';
import { makeTitle } from './ids.js';
import { Kernel } from './kernel.js';
import { applyPending } from './services/control.js';
import { cleanStorage, getStorage } from './services/disk.js';
import { attachmentsBlock, saveAttachments } from './services/attachments.js';
import { RunStore } from './store.js';
import type { CoreSettings, RunFile } from './types.js';

const kernel = (t: { after: (fn: () => void) => void }) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-svc-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = { toolPaths: {} } as unknown as CoreSettings;
  return new Kernel({ dataDir, promptsDir: dataDir, env: process.env, getSettings: () => settings });
};

test('saveAttachments: выход из каталога и странные имена не проходят, порядок сохраняется', (t) => {
  const k = kernel(t);
  const data = new Uint8Array([1]);
  const files = saveAttachments(k, 'r1', [
    { name: '../../evil.PNG', data },
    { name: '..\\..\\win.txt', data },
    { name: 'скрин экрана (1).png', data },
    { name: '', data },
    { name: 'x.p/ng', data },
  ]);
  const dir = path.join(k.opts.dataDir, 'attachments', 'r1');
  for (const f of files) assert.equal(path.dirname(f), dir, f);
  assert.equal(new Set(files).size, 5);
  assert.equal(path.basename(files[0]), '01-evil.png');
  assert.match(path.basename(files[2]), /^03-скрин-экрана-1-?\.png$/);
  assert.match(path.basename(files[3]), /^04-file/);
  assert.deepEqual(saveAttachments(k, 'r2', []), []);
});

test('attachmentsBlock: картинки — путём, текст — содержимым', (t) => {
  const k = kernel(t);
  const [img, txt] = saveAttachments(k, 'r', [
    { name: 'a.png', data: new Uint8Array([1]) },
    { name: 'b.txt', data: new TextEncoder().encode('содержимое лога') },
  ]);
  const block = attachmentsBlock(k, { id: 'r', attachments: [img, txt] } as RunFile);
  assert.ok(block.includes(img));
  assert.ok(block.includes('содержимое лога'));
  assert.equal(attachmentsBlock(k, { id: 'r' } as RunFile), '');
});

test('хранилище: чистка браузера, снимков и брошенных копий не трогает чужое', async (t) => {
  const k = kernel(t);
  const attempt = path.join(k.opts.dataDir, 'visual', 'r1', '1');
  fs.mkdirSync(path.join(attempt, 'chrome-profile'), { recursive: true });
  fs.writeFileSync(path.join(attempt, 'chrome-profile', 'state'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(attempt, 'shot.png'), Buffer.alloc(4096));
  const root = k.store.worktreesDir();
  fs.mkdirSync(path.join(root, 'orphan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'orphan', 'f'), Buffer.alloc(4096));
  fs.mkdirSync(path.join(root, 'merge-keep'), { recursive: true });

  const items = await getStorage(k);
  const bytes = (id: string) => items.find((i) => i.id === id)?.bytes ?? 0;
  assert.ok(bytes('browser') > 0);
  assert.ok(bytes('shots') > 0);
  assert.ok(bytes('worktrees-orphan') > 0);

  assert.ok((await cleanStorage(k, 'browser')) > 0);
  assert.ok(!fs.existsSync(path.join(attempt, 'chrome-profile')));
  assert.ok(fs.existsSync(path.join(attempt, 'shot.png')));

  assert.ok((await cleanStorage(k, 'shots')) > 0);
  assert.ok(!fs.existsSync(path.join(attempt, 'shot.png')));

  await cleanStorage(k, 'worktrees-orphan');
  assert.ok(!fs.existsSync(path.join(root, 'orphan')));
  assert.ok(fs.existsSync(path.join(root, 'merge-keep')), 'копии слияния занимает идущая операция');
});

test('чистка готовых копий: вне каталога worktrees не удаляет, в похожем по имени — тоже', async (t) => {
  const k = kernel(t);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-svc-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const outside = `${k.store.worktreesDir()}-x`;
  fs.mkdirSync(outside, { recursive: true });
  const r = {
    id: 'r',
    changeId: 'c',
    createdAt: '2026-01-01',
    status: 'finished',
    workspace: 'worktree',
    projectPath: repo,
    worktreePath: outside,
    worktreeRemoved: true,
    attempts: [],
  } as unknown as RunFile;
  k.store.save(r);
  k.store.save({ ...r, worktreeRemoved: undefined });
  await cleanStorage(k, 'worktrees-done');
  assert.ok(fs.existsSync(outside));
});

test('RunStore.inProject: где живёт run.json', () => {
  const r = (p: Partial<RunFile>) => ({ workspace: 'worktree', mode: 'task', ...p }) as RunFile;
  assert.equal(RunStore.inProject(r({})), true);
  assert.equal(RunStore.inProject(r({ worktreeRemoved: true })), false);
  assert.equal(RunStore.inProject(r({ workspacePending: true })), false);
  assert.equal(RunStore.inProject(r({ workspace: 'branch', mode: 'quick' })), false);
  assert.equal(RunStore.inProject(r({ workspace: 'branch' })), true);
});

test('applyPending: заметка ждёт стадию агента, пауза — срабатывает сразу', (t) => {
  const k = kernel(t);
  const base = {
    id: 'r',
    changeId: 'c',
    createdAt: '2026-01-01',
    status: 'running',
    workspace: 'worktree',
    worktreeRemoved: true,
    attempts: [],
  };
  const note = { kind: 'note', text: 'учти', at: '1' };
  const pause = { kind: 'pause', at: '2' };
  const run = (p: object) =>
    ({
      ...base,
      interventions: [
        { at: '1', kind: 'note' },
        { at: '2', kind: 'pause' },
      ],
      ...p,
    }) as unknown as RunFile;

  assert.equal(applyPending(k, run({ next: 'implement' })), false);

  const onTests = run({ next: 'tests', pending: [note] });
  assert.equal(applyPending(k, onTests), false);
  assert.equal(onTests.pending?.length, 1);
  assert.equal(onTests.feedback, undefined);

  const onImpl = run({ next: 'implement', pending: [note], feedback: { source: 'tests', text: 'упало' } });
  assert.equal(applyPending(k, onImpl), false);
  assert.equal(onImpl.pending, undefined);
  assert.equal(onImpl.feedback?.source, 'tests');
  assert.match(onImpl.feedback?.text ?? '', /упало[\s\S]*учти/);
  assert.ok(onImpl.interventions?.[0].appliedAt);

  const paused = run({ next: 'tests', pending: [note, pause] });
  assert.equal(applyPending(k, paused), true);
  assert.equal(paused.status, 'stopped');
  assert.equal(paused.pending?.length, 1, 'заметка ждёт исполнителя и после паузы');
  assert.match(paused.message ?? '', /Пауза/);
});

test('makeTitle: первая строка, длинная — с многоточием', () => {
  assert.equal(makeTitle('  Сделай\nподробности'), 'Сделай');
  const long = makeTitle('я'.repeat(100));
  assert.equal(long.length, 78);
  assert.ok(long.endsWith('…'));
});

test('detectProjectCommands: менеджеры пакетов и языки, битый package.json не роняет', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-detect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inDir = (name: string, files: Record<string, string>) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d);
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
    return detectProjectCommands(d);
  };
  const pkg = JSON.stringify({ scripts: { test: 'x', lint: 'y' }, dependencies: { a: '1' } });
  assert.deepEqual(inDir('npm', { 'package.json': pkg, 'package-lock.json': '{}' }), {
    testCommand: 'npm test',
    setupCommand: 'npm ci',
    lintCommand: 'npm run lint',
    detectedFrom: 'package.json',
  });
  assert.equal(inDir('pnpm', { 'package.json': pkg, 'pnpm-lock.yaml': '' }).setupCommand, 'pnpm install');
  assert.equal(inDir('nodeps', { 'package.json': '{"scripts":{}}' }).setupCommand, '');
  assert.equal(inDir('go', { 'go.mod': '' }).testCommand, 'go test ./...');
  assert.equal(inDir('poetry', { 'pyproject.toml': '[tool.poetry]\n[tool.ruff]\n' }).lintCommand, 'poetry run ruff check .');
  assert.equal(inDir('uv', { 'pyproject.toml': '', 'uv.lock': '' }).testCommand, 'uv run pytest');
  assert.equal(inDir('py', { 'pyproject.toml': '' }).testCommand, 'python -m pytest');
  assert.equal(inDir('rust', { 'Cargo.toml': '' }).testCommand, 'cargo test');
  assert.equal(inDir('empty', {}).detectedFrom, null);
  assert.doesNotThrow(() => inDir('broken', { 'package.json': '{ битый' }));
});

test('checkCommand: нет скрипта — подсказка; флаг и workspace — без ложной тревоги', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  assert.deepEqual(checkCommand(dir, 'npm run test'), []);
  assert.equal(checkCommand(dir, 'npm run build').length, 1);
  // Какой пакет — не понять, предупреждать не о чем.
  for (const cmd of ['pnpm --filter web dev', 'pnpm -r test', 'npm run -w web build', 'yarn workspace web build'])
    assert.deepEqual(checkCommand(dir, cmd), [], cmd);
});
