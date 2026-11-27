import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentionSegments } from './mentions';
import { expandPicks, formatPick, insertPick, PICK_SCRIPT, pickLabel, pickToken, splitPicks, type PickedElement } from './pickElement';

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

test('insertPick: токен — в строку через пробел, курсор — для просьбы после', () => {
  assert.equal(insertPick('', 'E'), 'E ');
  assert.equal(insertPick('Поправь   \n', 'E'), 'Поправь E ');
});

test('PICK_SCRIPT: синтаксически корректен', () => {
  // new Function только разбирает код, не выполняет его.
  assert.doesNotThrow(() => new Function(`return ${PICK_SCRIPT}`));
});

const button: PickedElement = {
  url: 'http://localhost:58058/sign-in',
  tag: 'div',
  classes: ['css-view-g5y9jx'],
  text: 'Продолжить',
  selector: 'button > div',
  components: ['View', 'Pressable', 'PrimaryButton'],
  width: 358,
  height: 50,
};

test('элемент страницы: в поле — короткий чип, агенту — полное описание, в пузыре — снова чип', () => {
  assert.equal(pickLabel(button), 'PrimaryButton «Продолжить»');
  assert.equal(pickLabel({ ...button, components: undefined, tag: 'a', text: undefined }), 'a');
  const text = insertPick('Сделай кнопку шире', pickToken(button));
  assert.equal(text, 'Сделай кнопку шире ⌖PrimaryButton «Продолжить» ');
  // Чип — ровно токен, остальное — текст.
  assert.deepEqual(mentionSegments(text, new Set()), [
    { text: 'Сделай кнопку шире ' },
    { text: '⌖PrimaryButton «Продолжить»', kind: 'pick' },
    { text: ' ' },
  ]);
  const sent = expandPicks(text.trim());
  assert.match(sent, /— Элементы со страницы —\n⌖PrimaryButton «Продолжить»:\nЭлемент на странице localhost:58058\/sign-in/);
  assert.match(sent, /- селектор: button > div/);
  const shown = splitPicks(sent);
  assert.equal(shown.text, 'Сделай кнопку шире ⌖PrimaryButton «Продолжить»');
  assert.match(shown.details.get('PrimaryButton «Продолжить»') ?? '', /размер: 358×50/);
  // Без элементов — текст как есть.
  assert.equal(expandPicks('просто текст'), 'просто текст');
  assert.equal(splitPicks('просто текст').text, 'просто текст');
});
