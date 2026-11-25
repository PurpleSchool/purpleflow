// Адаптер opencode: аргументы, конфиг поверх настроек пользователя, разбор событий `opencode run --format json`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentStep } from './agents/common.js';
import {
  opencodeArgs,
  opencodeConfig,
  opencodeModel,
  opencodeSteps,
  parseMajor,
  runOpencode,
  type OpencodeOptions,
} from './agents/opencode.js';

const unix = { skip: process.platform === 'win32' };
const PROXY = { baseUrl: 'https://proxy.test/api/', apiKey: 'key' };

/** Фейковый opencode: печатает события, запоминает stdin, аргументы и OPENCODE_CONFIG_CONTENT. */
function fakeOpencode(
  t: { after: (fn: () => void) => void },
  lines: unknown[],
  o: { code?: number; stderr?: string; version?: string } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-opencode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out.jsonl');
  fs.writeFileSync(out, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "${o.version ?? '1.19.6'}"; exit 0; fi`,
      `cat > "${dir}/stdin"`,
      `printf '%s' "$PWD" > "${dir}/pwd"`,
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `printf '%s' "$OPENCODE_CONFIG_CONTENT" > "${dir}/config"`,
      `printf '%s' "$PURPLEFLOW_OPENAI_API_KEY" > "${dir}/key"`,
      `cat "${out}"`,
      `echo "${o.stderr ?? ''}" >&2`,
      `exit ${o.code ?? 0}`,
    ].join('\n'),
    { mode: 0o755 },
  );
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  return {
    bin,
    dir,
    stdin: () => read('stdin'),
    args: () => read('args').trim().split('\n'),
    config: () => read('config'),
    pwd: () => read('pwd'),
    key: () => read('key'),
  };
}

function opts(bin: string, dir: string, p: Partial<OpencodeOptions> = {}) {
  const steps: AgentStep[] = [];
  const o: OpencodeOptions = {
    bin,
    cwd: dir,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: '{"чужой":true}' },
    prompt: 'задача',
    timeoutMs: 20_000,
    group: `opencode-${path.basename(dir)}`,
    onOutput: () => {},
    onStep: (s) => steps.push(s),
    ...p,
  };
  return { o, steps };
}

const S = 'ses_1';
const ev = (type: string, part: Record<string, unknown> = {}) => ({ type, sessionID: S, part });

test('opencodeModel: с прокси имя без провайдера — в провайдер прокси, «провайдер/модель» — как есть', () => {
  assert.equal(opencodeModel('gpt-6-sol', PROXY), 'purpleflow/gpt-6-sol');
  assert.equal(opencodeModel('openrouter/qwen', PROXY), 'openrouter/qwen');
  assert.equal(opencodeModel('gpt-6-sol', undefined), 'gpt-6-sol');
  assert.equal(opencodeModel('  ', undefined), undefined);
  // С прокси пустая модель — модель прокси, а не модель из настроек opencode (она шла бы мимо подписки).
  assert.equal(opencodeModel('  ', PROXY), 'purpleflow/gpt-6.1-terra');
  assert.equal(opencodeModel(undefined, PROXY), 'purpleflow/gpt-6.1-terra');
});

test('opencodeArgs: формат json, автоодобрение, папка, изоляция, модель, сессия, файлы', () => {
  assert.deepEqual(opencodeArgs({ cwd: '/w', userConfig: true }), ['run', '--format', 'json', '--auto', '--dir', '/w']);
  assert.deepEqual(opencodeArgs({ cwd: '/w', model: 'gpt-6-sol', proxy: PROXY, resumeSession: 's1', images: ['/a.png', '/b.png'] }), [
    'run',
    '--format',
    'json',
    '--auto',
    '--dir',
    '/w',
    '--pure',
    '-m',
    'purpleflow/gpt-6-sol',
    '-s',
    's1',
    '--file=/a.png',
    '--file=/b.png',
  ]);
});

test('opencodeArgs для opencode 2: без --dir и --pure, свой сервер (--standalone)', () => {
  assert.deepEqual(opencodeArgs({ cwd: '/w', model: 'gpt-6-sol', proxy: PROXY, resumeSession: 's1', images: ['/a.png'] }, 2), [
    'run',
    '--format',
    'json',
    '--auto',
    '--standalone',
    '-m',
    'purpleflow/gpt-6-sol',
    '-s',
    's1',
    '--file=/a.png',
  ]);
  assert.equal(parseMajor('2.3.2'), 2);
  assert.equal(parseMajor('opencode v1.19.6\n'), 1);
  assert.equal(parseMajor('что-то непонятное'), 1);
});

test('opencodeConfig: правки без полного доступа — shell без коммитов и kill, правки файлов разрешены', () => {
  const cfg = JSON.parse(opencodeConfig({ limited: true })!);
  assert.equal(cfg.permission.edit, undefined);
  assert.equal(cfg.permission.bash['*'], 'allow');
  for (const p of ['git commit*', 'git push*', 'kill *']) assert.equal(cfg.permission.bash[p], 'deny', p);
  // Только чтение строже и важнее.
  assert.equal(JSON.parse(opencodeConfig({ readOnly: true, limited: true })!).permission.edit, 'deny');
});

test('opencodeConfig: только чтение запрещает правки, прокси — провайдер с ключом из окружения', () => {
  assert.equal(opencodeConfig({}), undefined);
  const ro = JSON.parse(opencodeConfig({ readOnly: true })!);
  assert.equal(ro.permission.edit, 'deny');
  assert.equal(ro.permission.bash['*'], 'deny');
  assert.equal(ro.permission.bash['git diff*'], 'allow');
  const cfg = JSON.parse(opencodeConfig({ proxy: PROXY, model: 'gpt-6-sol' })!);
  assert.deepEqual(cfg.provider.purpleflow.options, { baseURL: 'https://proxy.test/api/v1', apiKey: '{env:PURPLEFLOW_OPENAI_API_KEY}' });
  assert.deepEqual(cfg.provider.purpleflow.models, { 'gpt-6-sol': {} });
  assert.deepEqual(JSON.parse(opencodeConfig({ proxy: PROXY })!).provider.purpleflow.models, { 'gpt-6.1-terra': {} });
  // Модель своего провайдера в прокси не объявляем.
  assert.deepEqual(JSON.parse(opencodeConfig({ proxy: PROXY, model: 'openrouter/qwen' })!).provider.purpleflow.models, {});
});

test('opencodeSteps: инструменты под привычными именами, итог по callID, план, ошибка', () => {
  const read = opencodeSteps(
    ev('tool_use', { tool: 'read', callID: 'c1', state: { status: 'completed', input: { filePath: '/w/a.txt' }, output: 'hello' } }),
  );
  assert.deepEqual(read, [
    { kind: 'tool', id: 'c1', text: 'Read /w/a.txt' },
    { kind: 'tool_result', id: 'c1', ok: true, output: 'hello' },
  ]);
  const edit = opencodeSteps(
    ev('tool_use', {
      tool: 'edit',
      callID: 'c2',
      state: { status: 'error', input: { filePath: '/w/a.txt', oldString: 'a', newString: 'b' }, error: 'запрещено' },
    }),
  );
  assert.deepEqual(edit, [
    { kind: 'tool', id: 'c2', text: 'Edit /w/a.txt', detail: '- a\n+ b' },
    { kind: 'tool_result', id: 'c2', ok: false, output: 'запрещено' },
  ]);
  assert.deepEqual(
    opencodeSteps(ev('tool_use', { tool: 'todowrite', state: { input: { todos: [{ content: 'шаг', status: 'in_progress' }] } } })),
    [{ kind: 'todos', items: [{ text: 'шаг', status: 'in_progress' }] }],
  );
  assert.deepEqual(opencodeSteps({ type: 'error', error: { name: 'UnknownError', data: { message: 'сбой' } } }), [
    { kind: 'notice', level: 'warn', text: 'opencode: сбой' },
  ]);
});

test('runOpencode: ответ — текст последнего шага, токены и стоимость, ID сессии; системный промпт впереди', unix, async (t) => {
  const cli = fakeOpencode(t, [
    ev('step_start'),
    ev('text', { text: 'Сейчас прочитаю.' }),
    ev('tool_use', { tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt' } }),
    ev('step_finish', { tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } }, cost: 0.01 }),
    ev('step_start'),
    ev('text', { text: 'готово' }),
    ev('step_finish', { tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 7, write: 1 } }, cost: 0.02 }),
  ]);
  let session = '';
  const { o, steps } = opts(cli.bin, cli.dir, { systemPrompt: 'СИСТЕМА', readOnly: true, onSession: (id) => (session = id) });
  const r = await runOpencode(o);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'готово');
  assert.equal(r.usage.input, 13);
  assert.equal(r.usage.output, 4);
  assert.equal(r.usage.cacheRead, 12);
  assert.equal(r.usage.cacheWrite, 1);
  assert.ok(Math.abs((r.usage.costUsd ?? 0) - 0.03) < 1e-9);
  assert.equal(session, S);
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['text', 'tool', 'tool_result', 'text'],
  );
  assert.match(cli.stdin(), /^СИСТЕМА\n\n---\n\nзадача$/);
  // Чужой OPENCODE_CONFIG_CONTENT из окружения заменён нашим.
  assert.equal(JSON.parse(cli.config()).permission.edit, 'deny');
});

test('runOpencode на opencode 2: флаги второй версии, папка через PWD, конфиг и ответ как раньше', unix, async (t) => {
  const cli = fakeOpencode(t, [ev('step_start'), ev('text', { text: 'ok' }), ev('step_finish')], { version: '2.3.2' });
  const { o } = opts(cli.bin, cli.dir, { readOnly: true });
  const r = await runOpencode(o);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'ok');
  assert.ok(cli.args().includes('--standalone'));
  assert.ok(!cli.args().includes('--dir') && !cli.args().includes('--pure'));
  assert.equal(cli.pwd(), o.cwd);
  assert.equal(JSON.parse(cli.config()).permission.edit, 'deny');
});

test('runOpencode: прокси — ключ в окружении, модель через провайдер прокси', unix, async (t) => {
  const cli = fakeOpencode(t, [ev('step_start'), ev('text', { text: 'ok' }), ev('step_finish')]);
  const r = await runOpencode(opts(cli.bin, cli.dir, { proxy: PROXY, model: 'gpt-6-sol' }).o);
  assert.equal(r.ok, true);
  assert.equal(cli.key(), 'key');
  assert.ok(cli.args().includes('purpleflow/gpt-6-sol'));
});

test('runOpencode: ошибка событием при коде 0 — провал; ненулевой код; не запустился', unix, async (t) => {
  const err = fakeOpencode(t, [
    { type: 'error', sessionID: S, error: { name: 'ProviderModelNotFoundError', data: { message: 'model xyz not found' } } },
  ]);
  const a = await runOpencode(opts(err.bin, err.dir).o);
  assert.equal(a.ok, false);
  assert.match(a.error ?? '', /модель недоступна/);

  const unknown = fakeOpencode(t, [
    { type: 'error', sessionID: S, error: { name: 'UnknownError', data: { message: 'Unexpected server error.' } } },
  ]);
  assert.match(
    (await runOpencode(opts(unknown.bin, unknown.dir, { model: 'nope/bad' }).o)).error ?? '',
    /«nope\/bad» недоступна.*opencode auth login/,
  );

  const auth = fakeOpencode(t, [], { code: 1, stderr: '401 Unauthorized' });
  assert.match((await runOpencode(opts(auth.bin, auth.dir).o)).error ?? '', /opencode auth login/);

  const code = fakeOpencode(t, [], { code: 1, stderr: 'паника' });
  assert.match((await runOpencode(opts(code.bin, code.dir).o)).error ?? '', /паника/);

  const missing = await runOpencode(opts(path.join(code.dir, 'нет'), code.dir).o);
  assert.match(missing.error ?? '', /не запустился/);
});
