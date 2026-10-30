// Сколько места занимают данные PurpleFlow и что из них можно удалить.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.js';

/** Размер каталога или файла в байтах. На macOS/Linux — du (быстро даже для node_modules), иначе обход. */
export async function sizeOf(p: string): Promise<number> {
  if (!fs.existsSync(p)) return 0;
  if (process.platform !== 'win32') {
    const r = await run('du', ['-sk', p], { cwd: path.dirname(p), env: process.env, timeoutMs: 120_000 }).catch(() => null);
    const kb = r && r.code === 0 ? Number(r.stdout.trim().split(/\s+/)[0]) : NaN;
    if (Number.isFinite(kb)) return kb * 1024;
  }
  return walkSize(p);
}

function walkSize(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of fs.readdirSync(p)) n += walkSize(path.join(p, e));
  return n;
}

export async function sizeOfAll(paths: string[]): Promise<number> {
  let n = 0;
  for (const p of paths) n += await sizeOf(p);
  return n;
}

/** Каталоги в dir (полные пути). */
export function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Служебные файлы браузера визуальной проверки: профиль Chrome и кэш Playwright CLI (скриншоты остаются). */
export function browserLeftovers(visualRoot: string): string[] {
  const out: string[] = [];
  for (const runDir of subdirs(visualRoot)) {
    for (const attemptDir of subdirs(runDir)) {
      for (const name of ['chrome-profile', '.playwright-cli']) {
        const p = path.join(attemptDir, name);
        if (fs.existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

/** Скриншоты визуальных проверок. */
export function screenshots(visualRoot: string): string[] {
  const out: string[] = [];
  for (const runDir of subdirs(visualRoot)) {
    for (const attemptDir of subdirs(runDir)) {
      try {
        for (const f of fs.readdirSync(attemptDir)) if (/\.(png|jpe?g|webp)$/i.test(f)) out.push(path.join(attemptDir, f));
      } catch {
        /* каталог пропал */
      }
    }
  }
  return out;
}
