import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightCode, markdownHtml } from './markdown';

test('markdownHtml: таблица GFM в прокручиваемой обёртке, с выравниванием', () => {
  const html = markdownHtml('| Механизм | Зачем |\n| :--- | :---: |\n| `cgroups` | ресурсы |\n');
  assert.match(html, /^<div class="md-table"><table>/);
  assert.match(html, /<\/table>\s*<\/div>/);
  assert.match(html, /<th align="left">Механизм<\/th>/);
  assert.match(html, /<td align="center">ресурсы<\/td>/);
  assert.match(html, /<td align="left"><code>cgroups<\/code><\/td>/);
});

test('markdownHtml: блок кода с языком — подсветка, подпись и кнопка «Копировать»', () => {
  const html = markdownHtml('```ts\nconst a: number = 1;\n```');
  assert.match(html, /<span class="md-code-lang">ts<\/span>/);
  assert.match(
    html,
    /<button type="button" class="md-copy" title="Копировать" aria-label="Копировать"><svg class="md-copy-icon"[^]*<svg class="md-copy-done"[^]*<\/button>/,
  );
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<span class="hljs-number">1<\/span>/);
  // Завершающий перевод строки не превращается в пустую строку блока.
  assert.match(html, /;<\/code><\/pre>/);
});

test('highlightCode: псевдонимы, неизвестный язык, блок без подписи, экранирование', () => {
  assert.equal(highlightCode('FROM node:22', 'Dockerfile').label, 'dockerfile');
  assert.match(highlightCode('FROM node:22', 'dockerfile').html, /hljs-keyword">FROM/);
  assert.equal(highlightCode('x', 'yml').label, 'yml');
  assert.match(highlightCode('echo $HOME', 'zsh').html, /hljs-built_in">echo|hljs-variable">\$HOME/);

  // Неизвестный язык: код как есть, но экранированный, подпись — как у автора.
  assert.deepEqual(highlightCode('<script>alert(1)</script>', 'brainfuck'), {
    html: '&lt;script&gt;alert(1)&lt;/script&gt;',
    label: 'brainfuck',
  });

  // Без подписи обычный текст не раскрашивается, а явный код угадывается.
  assert.deepEqual(highlightCode('Просто строка текста', ''), { html: 'Просто строка текста', label: '' });
  const guessed = highlightCode('{\n  "name": "purpleflow",\n  "private": true,\n  "version": "0.1.2"\n}');
  assert.equal(guessed.label, 'json');
  assert.match(guessed.html, /hljs-attr/);

  // Огромный блок не подсвечивается.
  const big = 'const a = 1;\n'.repeat(5000);
  assert.equal(highlightCode(big, 'js').html.includes('hljs-'), false);
});
