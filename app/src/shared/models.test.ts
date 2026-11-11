import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProxyModels } from './models';

test('parseProxyModels: берёт списки моделей и отбрасывает мусор', () => {
  assert.deepEqual(
    parseProxyModels({
      anthropic: [
        { id: 'claude-fable-5-2', displayName: ' Claude Fable 5.2 ' },
        { id: 'claude-fable-5-2', displayName: 'дубль' },
        { id: 'плохое имя', displayName: 'x' },
        { id: 42 },
        null,
      ],
      openai: [{ id: 'gpt-6-astra' }],
      extra: true,
    }),
    {
      anthropic: [{ id: 'claude-fable-5-2', displayName: 'Claude Fable 5.2' }],
      openai: [{ id: 'gpt-6-astra', displayName: '' }],
    },
  );
});

test('parseProxyModels: не тот ответ — null', () => {
  assert.equal(parseProxyModels(null), null);
  assert.equal(parseProxyModels('[]'), null);
  assert.equal(parseProxyModels({ anthropic: [] }), null);
  assert.equal(parseProxyModels({ message: 'Failed to get AI proxy models', statusCode: 500 }), null);
});

test('parseProxyModels: не больше сотни моделей', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `m-${i}`, displayName: '' }));
  assert.equal(parseProxyModels({ anthropic: many, openai: [] })!.anthropic.length, 100);
});
