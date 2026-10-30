import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capitalize, truncate } from './strings.ts';

test('capitalize', () => {
  assert.equal(capitalize('привет'), 'Привет');
  assert.equal(capitalize(''), '');
});

test('truncate', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});
