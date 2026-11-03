// Файлы, которые можно показать агенту: картинки и небольшие тексты.

import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** Путь внутри каталога. Не startsWith: иначе /data/worktrees-x считался бы частью /data/worktrees. */
export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Растровое изображение — его можно показать агенту как картинку. */
export function isImageFile(p: string): boolean {
  return IMAGE_EXT.has(path.extname(p).toLowerCase());
}

/** Текст файла, если он небольшой и похож на текст (без нулевых байтов, валидный UTF-8); иначе null. */
export function readSmallText(p: string, max = 16 * 1024): string | null {
  try {
    if (fs.statSync(p).size > max) return null;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}
