import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticsFrom } from './diagnostics';

test('diagnosticsFrom: новый выключатель, перенос двух старых, первый запуск', () => {
  assert.equal(diagnosticsFrom({ diagnostics: false, errorReports: true, usageEvents: true }), false);
  assert.equal(diagnosticsFrom({ diagnostics: true, onboarded: true }), true);
  // Два старых: выключен любой — выключен общий.
  assert.equal(diagnosticsFrom({ onboarded: true, errorReports: true, usageEvents: true }), true);
  assert.equal(diagnosticsFrom({ onboarded: true, errorReports: false, usageEvents: true }), false);
  assert.equal(diagnosticsFrom({ onboarded: true, errorReports: true, usageEvents: false }), false);
  // Настроил до появления отчётов — предупреждения не видел.
  assert.equal(diagnosticsFrom({ onboarded: true }), false);
  assert.equal(diagnosticsFrom({ onboarded: true, errorReports: true }), false);
  // Первый запуск: включено, но до конца настройки ничего не уходит (это проверяет onboarded при отправке).
  assert.equal(diagnosticsFrom({}), true);
});
