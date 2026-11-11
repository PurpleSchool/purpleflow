import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_OPTIONS, mergeModelOptions } from './models';

const remote = {
  anthropic: [
    { id: 'claude-fable-5-2', displayName: 'Claude Fable 5.2' },
    { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
    { id: 'claude-x', displayName: 'claude-x' },
  ],
  openai: [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
    { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' },
    { id: 'gemini-3.8-flash', displayName: '' },
  ],
};

test('mergeModelOptions: без списка прокси — встроенные', () => {
  assert.equal(mergeModelOptions(null, true), MODEL_OPTIONS);
  assert.equal(mergeModelOptions(null, false), MODEL_OPTIONS);
});

test('mergeModelOptions: новые модели прокси — после встроенных, без дублей', () => {
  const m = mergeModelOptions(remote, true);
  assert.deepEqual(
    m.claude.map((o) => o.value),
    [...MODEL_OPTIONS.claude.map((o) => o.value), 'claude-opus-5-5', 'claude-x'],
  );
  // У встроенной модели остаётся наша подсказка, у новой — название с сервера; одинаковое с id не повторяем.
  assert.equal(m.claude[0].hint, MODEL_OPTIONS.claude[0].hint);
  assert.equal(m.claude.find((o) => o.value === 'claude-opus-5-5')!.hint, 'Claude Opus 5.5');
  assert.equal(m.claude.find((o) => o.value === 'claude-x')!.hint, undefined);
});

test('mergeModelOptions: модели не своего семейства — только через прокси и с пометкой', () => {
  const on = mergeModelOptions(remote, true);
  assert.deepEqual(on.codex.slice(MODEL_OPTIONS.codex.length), [
    { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol', hint: 'GPT-6.1 Sol' },
    { value: 'gemini-4-argon', label: 'gemini-4-argon', hint: 'Gemini 4 Argon · только через AI-прокси PurpleSchool' },
    { value: 'gemini-3.8-flash', label: 'gemini-3.8-flash', hint: 'только через AI-прокси PurpleSchool' },
  ]);
  // Без прокси Gemini не запустится по подписке OpenAI — его не предлагаем; свои модели остаются.
  const off = mergeModelOptions(remote, false);
  assert.deepEqual(
    off.codex.map((o) => o.value),
    [...MODEL_OPTIONS.codex.map((o) => o.value), 'gpt-6.1-sol'],
  );
  assert.deepEqual(
    off.claude.map((o) => o.value),
    on.claude.map((o) => o.value),
  );
});
