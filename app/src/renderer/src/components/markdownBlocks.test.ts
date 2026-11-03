import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocksOf } from './markdownBlocks';

test('blocksOf: строка каждого блока совпадает со строкой в файле', () => {
  const source =
    '# Заголовок\n\nАбзац **жирный**\nвторая строка\n\n- пункт один\n- пункт два\n\n3. третий\n4. четвёртый\n\n---\n\n```js\nconst a = 1;\n```\n\nКонец\n';
  const lines = source.split('\n');
  const blocks = blocksOf(source);
  assert.deepEqual(
    blocks.map((b) => b.line),
    [1, 3, 6, 7, 9, 10, 14, 18],
  );
  // Привязка замечания держится на номере строки: блок начинается именно там.
  for (const b of blocks) assert.equal(lines[b.line - 1], b.md.split('\n')[0]);
  assert.match(blocks[1].quote, /^Абзац жирный/);
  assert.equal(blocks[4].md, '3. третий');
  assert.deepEqual(blocksOf(''), []);
});
