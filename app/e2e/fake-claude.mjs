// Фейковый claude: тот же протокол, что у настоящего (промпт в stdin, ответ — stream-json), ответ зависит от промпта.
// Маркеры в тексте задачи задают сценарий: СЛОМАЙ_АГЕНТА — агент падает с сообщением в stderr.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.0.0 (Claude Code)');
  process.exit(0);
}

// `claude mcp …` — только серверы проекта в .mcp.json папки запуска. «broken…» не подключаются.
if (args[0] === 'mcp') {
  const file = path.join(process.cwd(), '.mcp.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mcpServers: {} };
  const save = () => fs.writeFileSync(file, JSON.stringify(cfg));
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args })}\n`);
  if (args[1] === 'list') {
    console.log('Checking MCP server health…\n');
    for (const name of Object.keys(cfg.mcpServers))
      console.log(`${name}: x - ${name.startsWith('broken') ? '✗ Failed to connect' : '✔ Connected'}`);
  } else if (args[1] === 'remove') {
    delete cfg.mcpServers[args[2]];
    save();
  } else if (args[1] === 'add-json') {
    cfg.mcpServers[args[2]] = JSON.parse(args[3]);
    save();
  }
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
// Название чата после первого ответа: отдаём начало первого сообщения — названия в тестах не меняются.
if (/^Придумай короткое название для чата/.test(prompt)) {
  // Пауза: окно успевает показать заглушку на месте названия.
  await new Promise((r) => setTimeout(r, 600));
  reply(prompt.match(/Человек: ([^\n]*)/)?.[1]?.slice(0, 60) ?? 'Чат');
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

// НЕТ_ТОКЕНОВ: generate_image падает — на балансе не хватает токенов (под ответом — карточка подписки).
if (/НЕТ_ТОКЕНОВ/.test(prompt)) {
  say({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() });
  say({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'img2', name: 'mcp__purpleschool__generate_image', input: { prompt: 'A cat' } }] },
  });
  say({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'img2',
          is_error: true,
          content: [{ type: 'text', text: 'Insufficient balance. Top up your subscription.' }],
        },
      ],
    },
  });
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Не получилось: не хватает токенов.',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  process.exit(0);
}

// НАРИСУЙ_КОТА: «вызов» generate_image MCP PurpleSchool — если окно подключило сервер (--mcp-config) и ключ пришёл
// в окружении. Ссылка на картинку — с того же фейкового сервера, что и MCP.
if (/НАРИСУЙ_КОТА/.test(prompt)) {
  const cfg = opt('--mcp-config');
  const server = cfg ? JSON.parse(cfg).mcpServers?.purpleschool : null;
  if (!server || !process.env.PURPLEFLOW_MEDIA_KEY) reply(`MCP не подключён: ${server ? 'нет ключа' : 'нет сервера'}`);
  const auth = server.headers?.Authorization === 'Bearer ${PURPLEFLOW_MEDIA_KEY}' ? 'env' : 'плохой заголовок';
  say({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() });
  say({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'img1',
          name: 'mcp__purpleschool__generate_image',
          input: { prompt: 'A cozy orange cat', model: 'flux-3-klein' },
        },
      ],
    },
  });
  say({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'img1',
          content: [{ type: 'text', text: JSON.stringify({ status: 'completed', url: server.url.replace(/\/mcp$/, '/img/cat.png') }) }],
        },
      ],
    },
  });
  say({ type: 'assistant', message: { content: [{ type: 'text', text: `Нарисовал кота (ключ: ${auth}).` }] } });
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `Нарисовал кота (ключ: ${auth}).`,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  process.exit(0);
}

// Визуальная проверка: настоящий pw из PATH (браузер уже открыт PurpleFlow) — снимок, телефонная ширина, скриншот.
// ДЕРЖИ_БРАУЗЕР в задаче — подождать, пока тест смотрит на окно; вывод pw — в pw.log рядом с журналом вызовов.
if (/QA-инженер в конвейере PurpleFlow/.test(sys)) {
  const pw = (...a) => {
    let out;
    try {
      out = execFileSync('pw', a, { encoding: 'utf8', timeout: 60_000 });
    } catch (e) {
      out = `ERR ${e.stdout ?? ''} ${e.message}`;
    }
    if (process.env.FAKE_CLAUDE_LOG)
      fs.appendFileSync(path.join(path.dirname(process.env.FAKE_CLAUDE_LOG), 'pw.log'), `$ pw ${a.join(' ')}\n${out}\n`);
    return out;
  };
  pw('snapshot');
  pw('resize', '390', '844');
  pw('screenshot', '--filename', 'mobile.png');
  if (/ДЕРЖИ_БРАУЗЕР/.test(prompt)) await new Promise((r) => setTimeout(r, 8000));
  reply(
    JSON.stringify({
      blocking: [],
      passed: ['Страница открылась, на 390px не ломается'],
      notes: [],
      shots: [{ file: 'mobile.png', caption: 'Телефон' }],
      unverified: null,
    }),
  );
}

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
// Как codex: отказ песочницы без события вызова — только просьба в тексте.
if (/чате PurpleFlow/.test(sys) && /Закоммить молча/.test(prompt) && /"sandbox"/.test(opt('--settings')))
  reply('Не удалось создать коммит: песочница запретила запись в .git/index.lock. Для этого нужен режим «Полный доступ».', true);
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
