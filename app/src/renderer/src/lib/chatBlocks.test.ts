import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatToolPart } from '@purpleflow/core';
import { answerFooter, answerText, chatBlocks, shownTools } from './chatBlocks';

const tool = (text: string, status?: ChatToolPart['status']): ChatToolPart => ({ kind: 'tool', text, ...(status ? { status } : {}) });

test('chatBlocks: подряд идущие вызовы — одной группой, остальные части по порядку', () => {
  const blocks = chatBlocks({
    text: '',
    parts: [
      { kind: 'thinking', text: '' },
      tool('Read a'),
      tool('Grep b'),
      { kind: 'notice', level: 'warn', text: 'повтор' },
      tool('Bash c'),
      { kind: 'text', text: 'итог' },
    ],
  });
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'tools' ? `tools:${b.items.length}` : b.kind)),
    ['thinking', 'tools:2', 'notice', 'tools:1', 'text'],
  );
  // Старые сообщения без частей — один текстовый блок.
  assert.deepEqual(chatBlocks({ text: 'старый ответ' }), [{ kind: 'text', text: 'старый ответ' }]);
  assert.deepEqual(chatBlocks({ text: '' }), []);
});

test('shownTools: свёрнутая группа показывает последний и упавшие вызовы', () => {
  const items = [tool('a', 'ok'), tool('b', 'error'), tool('c', 'ok'), tool('d', 'running')];
  assert.deepEqual(
    shownTools(items, false).map((t) => t.text),
    ['b', 'd'],
  );
  assert.equal(shownTools(items, true).length, 4);
});

test('answerText: один вопрос — сам ответ, несколько — построчно', () => {
  const q = (question: string) => ({ question, options: [] });
  assert.equal(answerText([q('Какой?')], [['A', 'B']]), 'A, B');
  assert.equal(answerText([q('Один?'), q('Два?')], [['Да'], []]), 'Один? — Да\nДва? — без ответа');
});

test('answerFooter: модель, ходы, время, токены, стоимость', () => {
  assert.deepEqual(
    answerFooter({
      model: 'opus',
      turns: 3,
      durationMs: 75_000,
    }),
    ['opus', '3 хода', '1 мин 15 с'],
  );
  assert.deepEqual(
    answerFooter({ turns: 1 }).concat(answerFooter({ turns: 11 }), answerFooter({ turns: 21 }), answerFooter({ turns: 5 })),
    ['1 ход', '11 ходов', '21 ход', '5 ходов'],
  );
  assert.deepEqual(answerFooter({}), []);
});
