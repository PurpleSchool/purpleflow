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
    usage: { input_tokens: 10, output_tokens: 5 },
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
  fs.appendFileSync('src/math.js', 'export const mul = (a, b) => a * b;\n');
  reply('Добавил mul.');
}

// Служебное: профиль проекта, сводка, уроки, карта плана, подсказка режима.
reply('{}');
