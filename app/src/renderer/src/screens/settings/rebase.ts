/**
 * Настройки поменялись извне (открыт аккаунт, переключён звук, быстрая настройка):
 * поле, которое человек не трогал, берёт новое значение, а несохранённая правка остаётся.
 */
export function rebase<T>(draft: T, prev: T | undefined, next: T): T {
  return prev === undefined || JSON.stringify(draft) === JSON.stringify(prev) ? next : draft;
}
