import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cut, finalMessage } from './logSlice';

const log = '━━ Реализация · попытка 1 ━━\nпервая\n━━ Реализация · попытка 10 ━━\nдесятая\n━━ Проверки · попытка 1 ━━\nтесты\n';

test('cut: кусок одной попытки, «попытка 1» не находит «попытка 10»', () => {
  assert.equal(cut(log, { title: 'Реализация', attempt: 1 }), '━━ Реализация · попытка 1 ━━\nпервая\n');
  assert.equal(cut(log, { title: 'Реализация', attempt: 10 }), '━━ Реализация · попытка 10 ━━\nдесятая\n');
  assert.equal(cut(log, { title: 'Проверки', attempt: 1 }), '━━ Проверки · попытка 1 ━━\nтесты\n');
  assert.equal(cut(log, { title: 'Реализация', attempt: 2 }), '');
  const onlyTen = '━━ Реализация · попытка 10 ━━\nдесятая\n';
  assert.equal(cut(onlyTen, { title: 'Реализация', attempt: 1 }), '');
});

test('finalMessage: последний обычный текст, без инструментов и приглушённого вывода', () => {
  const violet = '\x1b[38;2;178;165;245m';
  const text = `Сначала думаю\n${violet}▸ \x1b[39mRead \x1b[2m/a.ts\x1b[22m\n\x1b[2mвывод\x1b[22m\nГотово: всё сделал\n`;
  assert.equal(finalMessage(text).trim(), 'Готово: всё сделал');
  assert.equal(finalMessage('').trim(), '');
});
