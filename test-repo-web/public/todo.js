/** Добавить задачу в список. Пустые строки игнорируются. */
export function addTodo(list, title) {
  const t = title.trim();
  return t ? [...list, { title: t, done: false }] : list;
}

/** Переключить отметку «выполнено». */
export function toggle(list, index) {
  return list.map((t, i) => (i === index ? { ...t, done: !t.done } : t));
}

/** Убрать выполненные задачи. */
export function clearDone(list) {
  return list.filter((t) => t.done);
}
