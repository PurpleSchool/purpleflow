import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiffFile } from '@purpleflow/core';
import { buildTree, treeOrder } from './tree';
import { fingerprint } from './viewed';

const file = (path: string, p: Partial<DiffFile> = {}): DiffFile => ({ path, status: 'M', original: '', modified: '', ...p }) as DiffFile;

test('buildTree: цепочка из одной папки склеивается, счётчики включают вложенные файлы', () => {
  const t = buildTree([file('packages/api/src/a.ts'), file('packages/api/src/b.ts'), file('root.ts')]);
  assert.equal(t.count, 3);
  assert.equal(t.dirs.length, 1);
  assert.equal(t.dirs[0].name, 'packages/api/src');
  assert.equal(t.dirs[0].path, 'packages/api/src');
  assert.equal(t.dirs[0].count, 2);
  assert.deepEqual(
    t.files.map((f) => f.path),
    ['root.ts'],
  );
});

test('buildTree: папка с файлом и подпапкой не склеивается', () => {
  const t = buildTree([file('src/a.ts'), file('src/lib/b.ts')]);
  assert.equal(t.dirs[0].name, 'src');
  assert.equal(t.dirs[0].count, 2);
  assert.equal(t.dirs[0].dirs[0].name, 'lib');
  assert.equal(t.dirs[0].dirs[0].path, 'src/lib');
});

test('buildTree и treeOrder: папки раньше файлов, openspec — в конце', () => {
  const t = buildTree([file('z.ts'), file('openspec/changes/x/proposal.md'), file('app/b.ts'), file('app/a.ts')]);
  assert.deepEqual(
    t.dirs.map((d) => d.path),
    ['app', 'openspec/changes/x'],
  );
  assert.deepEqual(
    treeOrder(t).map((f) => f.path),
    ['app/a.ts', 'app/b.ts', 'openspec/changes/x/proposal.md', 'z.ts'],
  );
});

test('buildTree: пустой дифф', () => {
  const t = buildTree([]);
  assert.equal(t.count, 0);
  assert.deepEqual(treeOrder(t), []);
});

test('fingerprint: меняется вместе с содержимым и статусом, у одинаковых файлов совпадает', () => {
  const a = file('a.ts', { original: 'x', modified: 'y' });
  assert.equal(fingerprint(a), fingerprint(file('b.ts', { original: 'x', modified: 'y' })));
  assert.notEqual(fingerprint(a), fingerprint(file('a.ts', { original: 'x', modified: 'z' })));
  assert.notEqual(fingerprint(a), fingerprint(file('a.ts', { original: 'x', modified: 'y', status: 'A' })));
  // Граница между «до» и «после» значима: текст не просто склеивается.
  assert.notEqual(fingerprint(file('a', { original: 'ab', modified: 'c' })), fingerprint(file('a', { original: 'a', modified: 'bc' })));
});
