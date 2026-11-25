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
/** session — для чата: MCP-серверы в init, заполнение контекста и окно модели. */
function reply(text, session) {
  say({
    type: 'system',
    subtype: 'init',
    model: 'fake',
    cwd: process.cwd(),
    ...(session && { claude_code_version: '2.0.0', mcp_servers: [{ name: 'github', status: 'connected' }] }),
  });
  say({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      ...(session && { usage: { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 9990, output_tokens: 0 } }),
    },
  });
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage: { input_tokens: 21400, output_tokens: 1860 },
    total_cost_usd: 0.001,
    ...(session && { modelUsage: { fake: { contextWindow: 200_000 } } }),
  });
  process.exit(0);
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// Ручное сжатие контекста: как настоящий claude — статус, граница сжатия с размерами, пустой итог.
if (prompt.trim() === '/compact') {
  say({ type: 'system', subtype: 'status', status: 'compacting' });
  say({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() });
  say({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 50_000, post_tokens: 9000 } });
  say({ type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 0, output_tokens: 0 } });
  process.exit(0);
}
if (/Ты — менеджер прогона/.test(prompt)) reply('{"reply": "Всё идёт по плану."}');
if (/Перед планом проверь/.test(prompt)) reply('{"questions": []}');
if (/второй, независимый ревьюер/.test(prompt)) reply('{"items": []}');
// Ревью кода: одно важное замечание и одна заметка — на разбор человеку.
if (/ревьюер кода в PurpleFlow/.test(prompt))
  reply(
    JSON.stringify({
      blocking: [{ file: 'src/math.js', line: 1, message: 'sub складывает вместо вычитания', origin: null }],
      notes: [{ file: null, line: null, message: 'Не проверено: тесты не запускались', origin: null }],
      plan: [],
    }),
  );
// РЕВЬЮ_ПО_КРУГУ (маркер попадает в proposal, а он — в промпт ревьюера): ревьюер стоит на своём замечании,
// пока человек не уточнит его.
if (/ревьюер в конвейере PurpleFlow/.test(prompt) && /РЕВЬЮ_ПО_КРУГУ/.test(prompt) && !/Уточнения человека/.test(prompt)) {
  const origin = /повторное ревью/.test(prompt) ? 'unfixed' : 'new';
  reply(JSON.stringify({ blocking: [{ file: 'src/math.js', line: 1, message: 'mul не проверяет аргументы', origin }], notes: [] }));
}
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
    `# Умножение\n\n## Why\nНужно умножать два числа, сейчас есть только сложение, а задача его требует.${/РЕВЬЮ_ПО_КРУГУ/.test(prompt) ? ' РЕВЬЮ_ПО_КРУГУ' : ''}\n\n## What Changes\n- Функция mul в src/math.js\n`,
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
  // Проект из нескольких репозиториев: рабочая папка — общая, src/math.js — в каждом репозитории.
  const targets = fs.existsSync('src/math.js')
    ? ['src/math.js']
    : fs
        .readdirSync('.')
        .map((d) => path.join(d, 'src/math.js'))
        .filter((f) => fs.existsSync(f));
  for (const f of targets) fs.appendFileSync(f, 'export const mul = (a, b) => a * b;\n');
  reply('Добавил mul.');
}

// Служебное: профиль проекта, сводка, уроки, карта плана, подсказка режима.
// Чат: ответ с таблицей и блоком кода — проверить разметку ответа.
// Чат: коммит в песочнице правок — git падает, как в настоящей песочнице; с полным доступом — получается.
if (/чате PurpleFlow/.test(sys) && /Включил полный доступ/.test(prompt)) reply('Закоммитил.', true);
if (/чате PurpleFlow/.test(sys) && /Закоммить правки/.test(prompt)) {
  const sandboxed = /"sandbox"/.test(opt('--settings'));
  say({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() });
  say({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'git-1', name: 'Bash', input: { command: 'git commit -am wip' } }] },
  });
  say({
    type: 'user',
    message: {
      content: [
        sandboxed
          ? {
              type: 'tool_result',
              tool_use_id: 'git-1',
              is_error: true,
              content: "fatal: Unable to create '.git/index.lock': Operation not permitted",
            }
          : { type: 'tool_result', tool_use_id: 'git-1', is_error: false, content: '[main 1a2b3c4] wip' },
      ],
    },
  });
  reply(sandboxed ? 'Песочница не пустила запись в .git.' : 'Закоммитил.', true);
}
if (/чате PurpleFlow/.test(sys) && /Покажи ссылки Markdown/.test(prompt)) reply('[Параметр](?view=example)\n\n[Якорь](#example)', true);
if (/чате PurpleFlow/.test(sys))
  reply('Пример:\n\n| Механизм | Зачем |\n| --- | --- |\n| cgroups | ресурсы |\n\n```ts\nconst a: number = 1;\n```', true);
reply('{}');
