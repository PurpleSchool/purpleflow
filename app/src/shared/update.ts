// Состояние обновления: main получает события electron-updater, окно рисует предложение обновиться.

export const RELEASES_URL = 'https://github.com/PurpleSchool/purpleflow/releases/latest';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'check-failed'; message: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; version: string; message: string };

export type UpdateEvent =
  | { type: 'check-started' }
  | { type: 'not-available'; version: string }
  | { type: 'available'; version: string }
  | { type: 'download-started' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string };

export function nextUpdateState(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case 'check-started':
      // Ручная проверка не должна прервать начатую загрузку и потерять готовое обновление.
      return s.kind === 'downloading' || s.kind === 'ready' ? s : { kind: 'checking' };
    case 'not-available':
      // Фоновой проверке показывать нечего: о результате спрашивали только при ручной.
      return s.kind === 'checking' ? { kind: 'latest', version: e.version } : s;
    case 'available':
      // Проверка повторяется по таймеру: та же версия не должна сбросить начатую загрузку и готовое обновление.
      if ((s.kind === 'downloading' || s.kind === 'ready') && s.version === e.version) return s;
      return { kind: 'available', version: e.version };
    case 'download-started':
      return s.kind === 'available' || s.kind === 'failed' ? { kind: 'downloading', version: s.version, percent: 0 } : s;
    case 'progress':
      return s.kind === 'downloading' ? { ...s, percent: Math.round(e.percent) } : s;
    case 'downloaded':
      return { kind: 'ready', version: e.version };
    case 'error':
      if (s.kind === 'checking') return { kind: 'check-failed', message: e.message };
      // Сбой фоновой проверки (нет сети) пользователю ни к чему: он обновления не просил. Важен сбой начатого обновления.
      return s.kind === 'downloading' || s.kind === 'ready' ? { kind: 'failed', version: s.version, message: e.message } : s;
  }
}
