// Дерево изменённых файлов по папкам.
import type { DiffFile } from '@purpleflow/core';

export interface TreeDir {
  /** Полный путь папки (ключ для свёрнутых). */
  path: string;
  /** Подпись: одиночные вложенные папки склеены — «packages/api/src». */
  name: string;
  dirs: TreeDir[];
  files: DiffFile[];
  /** Сколько файлов внутри, включая вложенные папки. */
  count: number;
}
/** Дерево изменённых файлов: папки раньше файлов, openspec/ — в конце, цепочки из одной папки склеены. */
export function buildTree(files: DiffFile[]): TreeDir {
  const root: TreeDir = { path: '', name: '', dirs: [], files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const p = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.find((d) => d.path === p);
      if (!next) node.dirs.push((next = { path: p, name: part, dirs: [], files: [], count: 0 }));
      node = next;
    }
    node.files.push(f);
  }
  const finish = (d: TreeDir): TreeDir => {
    d.dirs = d.dirs.map(finish);
    // Папка, где только одна вложенная папка и нет файлов, склеивается с ней.
    while (d.path && d.dirs.length === 1 && !d.files.length) {
      const only = d.dirs[0];
      Object.assign(d, { path: only.path, name: `${d.name}/${only.name}`, dirs: only.dirs, files: only.files });
    }
    d.dirs.sort((a, b) => Number(a.name.startsWith('openspec')) - Number(b.name.startsWith('openspec')) || a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
    d.count = d.files.length + d.dirs.reduce((n, x) => n + x.count, 0);
    return d;
  };
  return finish(root);
}
/** Файлы в порядке дерева — чтобы первым открывался верхний файл дерева. */
export function treeOrder(d: TreeDir): DiffFile[] {
  return [...d.dirs.flatMap(treeOrder), ...d.files];
}
