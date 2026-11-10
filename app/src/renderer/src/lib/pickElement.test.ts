import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPick, insertPick, PICK_SCRIPT } from './pickElement';

test('formatPick: тег, текст, компонент с файлом, селектор, атрибуты и размер', () => {
  assert.equal(
    formatPick({
      url: 'http://localhost:3000/',
      tag: 'a',
      classes: ['btn', 'btn-primary', 'big', 'x'],
      text: 'Создать',
      selector: 'main > section.hero > a.btn.btn-primary',
      components: ['CtaButton', 'Hero'],
      source: 'src/components/Hero.tsx:42',
      attrs: { href: '/signup' },
      width: 268,
      height: 118,
    }),
    [
      'Элемент на странице localhost:3000: <a.btn.btn-primary.big> «Создать»',
      '- компонент: CtaButton ← Hero (src/components/Hero.tsx:42)',
      '- селектор: main > section.hero > a.btn.btn-primary',
      '- ссылка: /signup',
      '- размер: 268×118',
    ].join('\n'),
  );
});

test('formatPick: без текста и компонентов — только то, что есть', () => {
  assert.equal(
    formatPick({ url: 'http://127.0.0.1:5173/app/settings', tag: 'div', id: 'root', selector: 'div#root', width: 10, height: 20 }),
    'Элемент на странице 127.0.0.1:5173/app/settings: <div#root>\n- селектор: div#root\n- размер: 10×20',
  );
  assert.match(formatPick({ url: 'http://x/', tag: 'p', selector: 'p', source: 'App.vue', width: 1, height: 1 }), /- файл: App\.vue/);
});

test('insertPick: отдельным абзацем, курсор — для просьбы после', () => {
  assert.equal(insertPick('', 'E'), 'E\n\n');
  assert.equal(insertPick('Поправь   \n', 'E'), 'Поправь\n\nE\n\n');
});

test('PICK_SCRIPT: синтаксически корректен', () => {
  // new Function только разбирает код, не выполняет его.
  assert.doesNotThrow(() => new Function(`return ${PICK_SCRIPT}`));
});
