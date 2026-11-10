// Сборка ответа чата из шагов агента.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentStep } from './agents/common.js';
import { applyStep, partsText, settleParts, type ChatAnswer } from './chatparts.js';

const build = (steps: AgentStep[]): ChatAnswer => {
  const a: ChatAnswer = { parts: [] };
  for (const s of steps) applyStep(a, s);
  return a;
};

test('applyStep: текст кусками и новыми блоками, размышления', () => {
  const a = build([
    { kind: 'thinking', text: '' },
    { kind: 'thinking', text: 'ду', delta: true },
    { kind: 'thinking', text: 'маю', delta: true },
    { kind: 'text', text: 'При', delta: true, fresh: true },
    { kind: 'text', text: 'вет', delta: true },
    // Новый текстовый блок без инструмента между ними не склеивается с прежним.
    { kind: 'text', text: 'Ещё', delta: true, fresh: true },
    { kind: 'text', text: 'Целиком' },
  ]);
  assert.deepEqual(a.parts, [
    { kind: 'thinking', text: 'думаю' },
    { kind: 'text', text: 'Привет' },
    { kind: 'text', text: 'Ещё' },
    { kind: 'text', text: 'Целиком' },
  ]);
  assert.equal(partsText(a.parts), 'Привет\n\nЕщё\n\nЦеликом');
});

test('applyStep: вызов обновляется по id, итог ставит статус и вывод', () => {
  const a = build([
    { kind: 'tool', id: 'w', text: 'Write' },
    { kind: 'tool', id: 'w', text: 'Write /a.ts', detail: 'код' },
    { kind: 'tool', id: 'b', text: 'Bash false' },
    { kind: 'tool', text: 'без id' },
    { kind: 'tool_result', id: 'w', ok: true },
    { kind: 'tool_result', id: 'b', ok: false, output: 'Exit code 1' },
    { kind: 'tool_result', id: 'нет', ok: false },
  ]);
  assert.deepEqual(a.parts, [
    { kind: 'tool', id: 'w', text: 'Write /a.ts', detail: 'код', status: 'ok' },
    { kind: 'tool', id: 'b', text: 'Bash false', status: 'error', output: 'Exit code 1' },
    { kind: 'tool', text: 'без id' },
  ]);
});

test('applyStep: шаги субагента — внутри его вызова, а не в ленте', () => {
  const a = build([
    { kind: 'tool', id: 'ag', text: 'Субагент: поиск' },
    { kind: 'tool', id: 's1', parent: 'ag', text: 'Grep foo' },
    { kind: 'tool', id: 's2', parent: 'ag', text: 'Read' },
    { kind: 'tool', id: 's2', parent: 'ag', text: 'Read /a.ts' },
    { kind: 'tool_result', id: 's1', parent: 'ag', ok: false },
    { kind: 'tool_result', id: 's2', parent: 'ag', ok: true, output: 'не сохраняется' },
    // Шаг неизвестного субагента показывать негде.
    { kind: 'tool', id: 'x', parent: 'чужой', text: 'Bash ls' },
    { kind: 'tool_result', id: 'ag', ok: true },
  ]);
  assert.deepEqual(a.parts, [
    {
      kind: 'tool',
      id: 'ag',
      text: 'Субагент: поиск',
      status: 'ok',
      sub: [
        { id: 's1', text: 'Grep foo', status: 'error' },
        { id: 's2', text: 'Read /a.ts', status: 'ok' },
      ],
    },
  ]);
});

test('applyStep: план один и встаёт в конец, уведомление с ключом заменяет прежнее, итоги хода', () => {
  const a = build([
    { kind: 'todos', items: [{ text: 'a', status: 'in_progress' }] },
    { kind: 'notice', level: 'info', key: 'compact', text: 'Сжимаю…' },
    { kind: 'text', text: 'ок' },
    { kind: 'notice', level: 'warn', text: 'без ключа' },
    { kind: 'notice', level: 'warn', text: 'без ключа' },
    { kind: 'notice', level: 'info', key: 'compact', text: 'Сжато' },
    { kind: 'todos', items: [{ text: 'a', status: 'completed' }] },
    { kind: 'question', id: 'q', questions: [{ question: 'Да?', options: [{ label: 'Да' }] }] },
    { kind: 'meta', model: 'm' },
    { kind: 'meta', turns: 2, durationMs: 10 },
  ]);
  assert.deepEqual(a.parts, [
    { kind: 'notice', level: 'info', key: 'compact', text: 'Сжато' },
    { kind: 'text', text: 'ок' },
    { kind: 'notice', level: 'warn', text: 'без ключа' },
    { kind: 'notice', level: 'warn', text: 'без ключа' },
    { kind: 'todos', items: [{ text: 'a', status: 'completed' }] },
    { kind: 'question', id: 'q', questions: [{ question: 'Да?', options: [{ label: 'Да' }] }] },
  ]);
  assert.equal(a.model, 'm');
  assert.equal(a.turns, 2);
  assert.equal(a.durationMs, 10);
});

test('applyStep: сведения о сессии копятся, а не затирают друг друга', () => {
  const a: ChatAnswer = { parts: [] };
  applyStep(a, { kind: 'meta', model: 'm', cwd: '/w', mcp: [{ name: 'gh', status: 'connected' }] });
  applyStep(a, { kind: 'meta', context: 1000 });
  applyStep(a, { kind: 'meta', context: 5000 });
  applyStep(a, { kind: 'meta', contextWindow: 200_000, turns: 2 });
  assert.equal(a.model, 'm');
  assert.equal(a.turns, 2);
  assert.deepEqual(a.info, { cwd: '/w', mcp: [{ name: 'gh', status: 'connected' }], context: 5000, contextWindow: 200_000 });
  assert.deepEqual(a.parts, []);
});

test('settleParts: после хода вызовы без итога не «выполняются»', () => {
  const a = build([
    { kind: 'tool', id: 'ag', text: 'Субагент' },
    { kind: 'tool', id: 's', parent: 'ag', text: 'Bash' },
    { kind: 'tool', id: 'ok', text: 'Read' },
    { kind: 'tool_result', id: 'ok', ok: true },
  ]);
  settleParts(a.parts);
  assert.deepEqual(a.parts, [
    { kind: 'tool', id: 'ag', text: 'Субагент', sub: [{ id: 's', text: 'Bash' }] },
    { kind: 'tool', id: 'ok', text: 'Read', status: 'ok' },
  ]);
});
