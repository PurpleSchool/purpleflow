import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextUpdateState, type UpdateEvent, type UpdateState } from './update';

const play = (events: UpdateEvent[], from: UpdateState = { kind: 'idle' }) => events.reduce(nextUpdateState, from);

test('обновление: предложение, загрузка, готово', () => {
  const s = play([{ type: 'available', version: '1.2.0' }, { type: 'download-started' }, { type: 'progress', percent: 41.6 }]);
  assert.deepEqual(s, { kind: 'downloading', version: '1.2.0', percent: 42 });
  assert.deepEqual(nextUpdateState(s, { type: 'downloaded', version: '1.2.0' }), { kind: 'ready', version: '1.2.0' });
});

test('обновление: повторная проверка той же версии не сбрасывает загрузку и готовое', () => {
  const again: UpdateEvent = { type: 'available', version: '1.2.0' };
  const downloading: UpdateState = { kind: 'downloading', version: '1.2.0', percent: 50 };
  const ready: UpdateState = { kind: 'ready', version: '1.2.0' };
  assert.deepEqual(nextUpdateState(downloading, again), downloading);
  assert.deepEqual(nextUpdateState(ready, again), ready);
  assert.deepEqual(nextUpdateState(ready, { type: 'available', version: '1.3.0' }), { kind: 'available', version: '1.3.0' });
});

test('обновление: сбой фоновой проверки не виден, сбой начатого обновления — виден', () => {
  const error: UpdateEvent = { type: 'error', message: 'нет сети' };
  assert.deepEqual(nextUpdateState({ kind: 'idle' }, error), { kind: 'idle' });
  const offered: UpdateState = { kind: 'available', version: '1.2.0' };
  assert.deepEqual(nextUpdateState(offered, error), offered);
  const failed = nextUpdateState({ kind: 'downloading', version: '1.2.0', percent: 9 }, error);
  assert.deepEqual(failed, { kind: 'failed', version: '1.2.0', message: 'нет сети' });
  // Повторить можно прямо из состояния сбоя.
  assert.equal(nextUpdateState(failed, { type: 'download-started' }).kind, 'downloading');
  assert.equal(nextUpdateState({ kind: 'ready', version: '1.2.0' }, error).kind, 'failed');
});

test('обновление: прогресс и старт загрузки вне своего состояния игнорируются', () => {
  assert.deepEqual(nextUpdateState({ kind: 'idle' }, { type: 'progress', percent: 10 }), { kind: 'idle' });
  assert.deepEqual(nextUpdateState({ kind: 'idle' }, { type: 'download-started' }), { kind: 'idle' });
});
