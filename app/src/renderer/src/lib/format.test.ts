import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost, duration, shortPath, tokens, usageTotal } from './format';

test('tokens: тысячи и миллионы по-русски', () => {
  assert.equal(tokens(950), '950');
  assert.equal(tokens(12_400), '12 тыс.');
  assert.equal(tokens(1_250_000), '1,3 млн');
  assert.equal(tokens(25_000_000), '25 млн');
});

test('usageTotal и cost', () => {
  const u = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.0947 };
  assert.equal(usageTotal(u), 10);
  assert.equal(usageTotal(undefined), 0);
  assert.equal(cost(u), '$0.095');
  assert.equal(cost({ ...u, costUsd: 12.5 }), '$12.50');
  assert.equal(cost({ ...u, costUsd: undefined }), null);
});

test('duration: секунды, минуты, часы', () => {
  const t0 = '2026-10-30T10:00:00Z';
  assert.equal(duration(t0, '2026-10-30T10:00:42Z'), '42 с');
  assert.equal(duration(t0, '2026-10-30T10:03:05Z'), '3 мин 5 с');
  assert.equal(duration(t0, '2026-10-30T12:10:00Z'), '2 ч 10 мин');
});

test('shortPath: домашний каталог — тильдой на macOS, Linux и Windows', () => {
  assert.equal(shortPath('/Users/anna/code/app'), '~/code/app');
  assert.equal(shortPath('/home/anna/app'), '~/app');
  assert.equal(shortPath('C:\\Users\\anna\\app'), '~\\app');
  assert.equal(shortPath('/opt/app'), '/opt/app');
});
