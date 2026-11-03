// Фейковый claude: тот же протокол, что у настоящего (промпт в stdin, ответ — stream-json), ответ зависит от промпта.
// Маркеры в тексте задачи задают сценарий: СЛОМАЙ_АГЕНТА — агент падает с сообщением в stderr.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.0.0 (Claude Code)');
  process.exit(0);
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
// Для скриншотов: шкала прогона с мгновенными стадиями выглядела бы пустой.
if (process.env.FAKE_CLAUDE_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_DELAY_MS)));
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const sys = opt('--append-system-prompt');
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, prompt })}\n`);

const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
function reply(text) {
  say({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() });
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage: { input_tokens: 21400, output_tokens: 1860 },
    total_cost_usd: 0.001,
  });
  process.exit(0);
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

if (/Ты — менеджер прогона/.test(prompt)) reply('{"reply": "Всё идёт по плану."}');
if (/Перед планом проверь/.test(prompt)) reply('{"questions": []}');
if (/второй, независимый ревьюер/.test(prompt)) reply('{"items": []}');
if (/ревьюер в конвейере PurpleFlow/.test(prompt)) reply('{"blocking": [], "notes": []}');

if (/планировщик/.test(sys)) {
  const id = prompt.match(/используй ровно его\): `([^`]+)`/)?.[1];
  const dir = path.join('openspec', 'changes', id);
  if (/slugify/.test(prompt)) {
    write(
      path.join(dir, 'proposal.md'),
      '# Функция slugify с транслитерацией\n\n## Why\nАдреса страниц строятся из русских заголовков: нужен предсказуемый и читаемый slug.\n\n## What Changes\n- Функция `slugify(s)` в `src/slugify.js`: транслитерация, нижний регистр, дефисы\n- Тесты на кириллицу, знаки препинания и пустую строку\n\n## Impact\nНовый модуль, существующий код не меняется.\n',
    );
    write(path.join(dir, 'tasks.md'), '## 1. Код\n- [ ] 1.1 slugify в src/slugify.js\n- [ ] 1.2 Тесты в src/slugify.test.js\n');
    write(
      path.join(dir, 'specs', 'strings', 'spec.md'),
      '## ADDED Requirements\n### Requirement: Slug из заголовка\nФункция SHALL переводить строку в латиницу в формате kebab-case.\n\n#### Scenario: Русский заголовок\n- **WHEN** вызвали slugify("Привет, мир!")\n- **THEN** результат privet-mir\n',
    );
    reply('План готов.');
  }
  write(
    path.join(dir, 'proposal.md'),
    '# Умножение\n\n## Why\nНужно умножать два числа, сейчас есть только сложение, а задача его требует.\n\n## What Changes\n- Функция mul в src/math.js\n',
  );
  write(path.join(dir, 'tasks.md'), '## 1. Код\n- [ ] 1.1 mul в src/math.js\n');
  write(
    path.join(dir, 'specs', 'calc', 'spec.md'),
    '## ADDED Requirements\n### Requirement: Умножение\nКалькулятор SHALL умножать.\n\n#### Scenario: Два числа\n- **WHEN** вызвали mul(2, 3)\n- **THEN** результат 6\n',
  );
  reply('План готов.');
}

if (/исполнитель/.test(sys) || /Реализуй изменение|Продолжаем то же изменение/.test(prompt)) {
  if (/СЛОМАЙ_АГЕНТА/.test(prompt)) {
    process.stderr.write('API Error: квота исчерпана\n');
    process.exit(1);
  }
  if (/slugify/.test(prompt)) {
    write(
      'src/slugify.js',
      "const MAP = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };\n\nexport function slugify(s) {\n  return [...s.toLowerCase()]\n    .map((c) => MAP[c] ?? c)\n    .join('')\n    .replace(/[^a-z0-9]+/g, '-')\n    .replace(/^-+|-+$/g, '');\n}\n",
    );
    write(
      'src/slugify.test.js',
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { slugify } from './slugify.js';\n\ntest('slugify', () => {\n  assert.equal(slugify('Привет, мир!'), 'privet-mir');\n  assert.equal(slugify('  Ёлка 2026  '), 'elka-2026');\n  assert.equal(slugify(''), '');\n});\n",
    );
    reply('Добавил slugify и тесты.');
  }
  fs.appendFileSync('src/math.js', 'export const mul = (a, b) => a * b;\n');
  reply('Добавил mul.');
}

// Служебное: профиль проекта, сводка, уроки, карта плана, подсказка режима.
reply('{}');
