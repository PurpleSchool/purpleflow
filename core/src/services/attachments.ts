// Файлы, приложенные к задаче: хранение в данных приложения и показ агенту.
import fs from 'node:fs';
import path from 'node:path';
import { isImageFile, readSmallText } from '../files.js';
import type { Kernel } from '../kernel.js';
import type { RunFile } from '../types.js';

export function attachmentsDir(h: Kernel, id: string): string {
  return path.join(h.opts.dataDir, 'attachments', id);
}

/** Файлы задачи (изображения, документы, логи) — в каталог данных приложения, чтобы не попасть в коммит репозитория. */
export function saveAttachments(h: Kernel, id: string, files: { name: string; data: Uint8Array }[]): string[] {
  if (!files.length) return [];
  const dir = attachmentsDir(h, id);
  fs.mkdirSync(dir, { recursive: true });
  return files.map((f, i) => {
    const ext = path
      .extname(f.name)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '');
    const base =
      path
        .basename(f.name, path.extname(f.name))
        .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
        .slice(0, 60) || 'file';
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${base}${ext}`);
    fs.writeFileSync(file, Buffer.from(f.data));
    return file;
  });
}

export function attachmentsBlock(h: Kernel, run: RunFile): string {
  if (!run.attachments?.length) return '';
  const images = run.attachments.filter(isImageFile);
  return [
    images.length
      ? `\nК задаче приложены изображения (макеты, скриншоты). Открой их инструментом Read и учитывай:\n${images.map((p) => `- ${p}`).join('\n')}\n`
      : '',
    filesBlock(h, run),
  ].join('');
}

/** Не изображения: небольшие текстовые — прямо в промпт, остальные — путями (агент прочитает сам). */
export function filesBlock(h: Kernel, run: RunFile): string {
  const files = (run.attachments ?? []).filter((p) => !isImageFile(p) && fs.existsSync(p));
  if (!files.length) return '';
  const fence = '`'.repeat(4);
  const parts = files.map((p) => {
    const name = path.basename(p).replace(/^\d+-/, '');
    const text = readSmallText(p);
    return text !== null
      ? `### ${name}\n\n${fence}\n${text}\n${fence}`
      : `- ${p} (${name}, ${Math.max(1, Math.round(fs.statSync(p).size / 1024))} КБ) — открой и прочитай, если нужно для задачи`;
  });
  return `\nК задаче приложены файлы от человека — учитывай их:\n\n${parts.join('\n\n')}\n`;
}

/** Вложение для показа в окне: data URL изображения; null — не изображение или файла нет. */
export function getAttachment(h: Kernel, id: string, index: number): string | null {
  const r = h.mustLoad(id);
  const file = r.attachments?.[index];
  if (!file || !fs.existsSync(file) || !isImageFile(file)) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}
