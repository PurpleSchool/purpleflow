import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelName, pickerSections } from './agentPicker';

const OPTS = {
  claude: [
    { value: 'opus', label: 'opus' },
    { value: 'sonnet', label: 'sonnet' },
  ],
  codex: [{ value: 'gpt-6-sol', label: 'gpt-6-sol' }],
  opencode: [{ value: 'openrouter/qwen', label: 'openrouter/qwen' }],
  agy: [{ value: 'gemini-3.8-flash-high', label: 'gemini-3.8-flash-high' }],
};

test('pickerSections: разделы по включённым агентам, «по умолчанию» первым', () => {
  const s = pickerSections(['claude', 'opencode'], OPTS, 'claude', '');
  assert.deepEqual(
    s.map((x) => x.agent),
    ['claude', 'opencode'],
  );
  assert.deepEqual(
    s[0].items.map((i) => i.model),
    ['', 'opus', 'sonnet'],
  );
  assert.deepEqual(
    s[1].items.map((i) => i.model),
    ['', 'openrouter/qwen'],
  );
});

test('pickerSections: поиск — только модели из списка, пустые разделы скрыты; ищет и по названию', () => {
  const found = pickerSections(['claude', 'codex', 'opencode'], OPTS, 'claude', 'qwen');
  assert.deepEqual(
    found.map((x) => x.agent),
    ['opencode'],
  );
  assert.deepEqual(
    found[0].items.map((i) => i.model),
    ['openrouter/qwen'],
  );
  // Незнакомое имя — ничего, своей модели нет.
  assert.deepEqual(pickerSections(['claude', 'codex'], OPTS, 'claude', 'dd'), []);
  // «gpt 6» находит gpt-6-sol по человеческому названию.
  assert.equal(pickerSections(['codex'], OPTS, 'codex', 'gpt 6')[0].items[0].model, 'gpt-6-sol');
});

test('modelName и порядок: новые сверху, псевдоним при версии того же семейства скрыт', () => {
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
  assert.equal(modelName('gpt-6.1-terra'), 'GPT 6.1 Terra');
  const opts = {
    ...OPTS,
    claude: [
      { value: 'claude-opus-4-8', label: '' },
      { value: 'opus', label: '', hint: 'Сильная' },
      { value: 'claude-opus-5-5', label: '' },
      { value: 'claude-fable-5-2', label: '' },
    ],
  };
  const items = pickerSections(['claude'], opts, 'claude', '')[0].items;
  // opus — то же, что Claude Opus 5.5: псевдоним скрыт, остаются версии от новых к старым.
  assert.deepEqual(
    items.map((i) => i.model),
    ['', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-opus-4-8'],
  );
  // Без версий семейства псевдоним остаётся.
  assert.deepEqual(
    pickerSections(['claude'], OPTS, 'claude', '')[0].items.map((i) => i.model),
    ['', 'opus', 'sonnet'],
  );
});
