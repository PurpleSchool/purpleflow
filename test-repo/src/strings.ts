/** Делает первую букву строки заглавной. */
export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Обрезает строку до max символов, добавляя многоточие. */
export function truncate(s: string, max: number): string {
  if (max < 1) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
