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

import { planTitle } from './orchestrator.js';
test('planTitle: H1 из proposal.md', () => {
  assert.equal(planTitle('# Email-уведомления админу о сроке ссылки\n\n## Why\n…'), 'Email-уведомления админу о сроке ссылки');
  assert.equal(planTitle('# Change: Add `slugify`\n'), 'Add slugify');
  assert.equal(planTitle('## Why\nтекст'), null);
});
test('planTitle: подчёркивания в идентификаторах сохраняются', () => {
  assert.equal(planTitle('# Константа `APP_ICON_COLORS` в strings.ts'), 'Константа APP_ICON_COLORS в strings.ts');
});

test('parseReview: origin повторного ревью сохраняется, неизвестный и null — отбрасываются', () => {
  const r = parseReview('{"blocking":[{"file":"a.ts","line":3,"message":"x","origin":"unfixed"},{"file":null,"line":null,"message":"z","origin":"weird"}],"notes":[{"file":null,"line":null,"message":"y","origin":null}]}');
  assert.equal(r?.blocking[0].origin, 'unfixed');
  assert.equal(r?.blocking[1].origin, undefined);
  assert.equal(r?.notes[0].origin, undefined);
});
