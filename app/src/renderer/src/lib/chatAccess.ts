import type { ChatFile } from '@purpleflow/core';

/** Режим чата: что агенту можно. Хранится в чате двумя флагами — edits и fullAccess. */
export type ChatAccess = 'read' | 'edits' | 'full';

export function accessOf(c: Pick<ChatFile, 'edits' | 'fullAccess'>): ChatAccess {
  return c.edits ? (c.fullAccess ? 'full' : 'edits') : 'read';
}

export function accessPatch(a: ChatAccess): Pick<ChatFile, 'edits' | 'fullAccess'> {
  return { edits: a !== 'read', fullAccess: a === 'full' };
}

export const ACCESS_OPTIONS: { value: ChatAccess; label: string; hint: string }[] = [
  { value: 'read', label: 'Вопросы', hint: 'Только читает файлы и отвечает' },
  {
    value: 'edits',
    label: 'Правки',
    hint: 'Меняет файлы проекта по просьбе. Git на запись, процессы и файлы вне проекта закрыты песочницей',
  },
  {
    value: 'full',
    label: 'Полный доступ',
    hint: 'Без песочницы: коммиты, остановка процессов, файлы вне проекта — когда вы просите',
  },
];
