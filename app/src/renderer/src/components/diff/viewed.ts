// Отметки «просмотрено»: сбрасываются, если файл в диффе изменился.
import type { DiffFile } from '@purpleflow/core';
import { useEffect, useState } from 'react';

/** Отпечаток содержимого: отметка «Просмотрено» снимается, если файл потом изменился. */
export function fingerprint(f: DiffFile): string {
  let h = 5381;
  const text = `${f.status}\0${f.original}\0${f.modified}`;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(36)}`;
}
/** Просмотренные файлы прогона: путь → отпечаток. Удобство одного человека — хватает localStorage. */
export function useViewed(key: string | undefined) {
  const storageKey = key ? `purpleflow.viewed.${key}` : null;
  const read = (): Record<string, string> => {
    if (!storageKey) return {};
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };
  const [marks, setMarks] = useState(read);
  useEffect(() => setMarks(read()), [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: Record<string, string>) => {
    setMarks(next);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* без памяти об отметках */
    }
  };
  return { marks, save, enabled: Boolean(storageKey) };
}
