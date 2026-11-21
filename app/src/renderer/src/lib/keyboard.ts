/** Ввод в полях блокирует общие клавиши ревью. Скрытое поле самого диффа принимает фокус редактора. */
export function isShortcutInput(target: EventTarget | null): boolean {
  const input = target instanceof Element ? target.closest('input, textarea, [contenteditable]') : null;
  return input !== null && !input.matches('.monaco-editor textarea.inputarea');
}
