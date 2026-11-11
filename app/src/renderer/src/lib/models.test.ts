import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_OPTIONS, mergeModelOptions } from './models';

test('mergeModelOptions: без списка прокси — встроенные', () => {
  assert.equal(mergeModelOptions(null), MODEL_OPTIONS);
});

test('mergeModelOptions: новые модели прокси — после встроенных, без дублей', () => {
  const m = mergeModelOptions({
    anthropic: [
      { id: 'claude-fable-5-2', displayName: 'Claude Fable 5.2' },
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
      { id: 'claude-x', displayName: 'claude-x' },
    ],
    openai: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }],
  });
  assert.deepEqual(
    m.claude.map((o) => o.value),
    [...MODEL_OPTIONS.claude.map((o) => o.value), 'claude-opus-5-5', 'claude-x'],
  );
  // У встроенной модели остаётся наша подсказка, у новой — название с сервера; одинаковое с id не повторяем.
  assert.equal(m.claude[0].hint, MODEL_OPTIONS.claude[0].hint);
  assert.equal(m.claude.find((o) => o.value === 'claude-opus-5-5')!.hint, 'Claude Opus 5.5');
  assert.equal(m.claude.find((o) => o.value === 'claude-x')!.hint, undefined);
  assert.deepEqual(m.codex.at(-1), { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol', hint: 'GPT-6.1 Sol' });
});
