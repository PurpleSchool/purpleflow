import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReview } from './orchestrator.js';

test('parseReview: чистый JSON', () => {
  const r = parseReview('{"blocking":[{"file":"a.ts","line":3,"message":"x"}],"notes":[]}');
  assert.deepEqual(r, { blocking: [{ file: 'a.ts', line: 3, message: 'x' }], notes: [] });
});

test('parseReview: JSON в ```json и строки вместо объектов', () => {
  const r = parseReview('Вот:\n```json\n{"blocking":[],"notes":["стиль"]}\n```');
  assert.deepEqual(r, { blocking: [], notes: [{ file: null, line: null, message: 'стиль' }] });
});

test('parseReview: не JSON', () => {
  assert.equal(parseReview('всё хорошо'), null);
});
