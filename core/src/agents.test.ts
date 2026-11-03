// Адаптеры агентов: флаги запуска и разбор потока событий на фейковых CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeArgs, claudeEnv, claudeInput, runClaude } from './agents/claude.js';
import { codexArgs, codexProxyBase, runCodex, type CodexOptions } from './agents/codex.js';
import { addUsage, clip, emptyUsage, explainError, type AgentRunOptions, type AgentStep } from './agents/common.js';
import { killGroup } from './proc.js';

const unix = { skip: process.platform === 'win32' };
const PROXY = { baseUrl: 'https://proxy.test/api/', apiKey: 'key' };

/** CLI-фейк: печатает строки stdout и stderr, выходит с кодом. */
function fakeCli(t: { after: (fn: () => void) => void }, lines: unknown[], o: { code?: number; stderr?: string; tail?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out.jsonl');
  fs.writeFileSync(out, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const bin = path.join(dir, 'cli');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `cat > "${dir}/stdin"`,
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `cat "${out}"`,
      `echo "${o.stderr ?? ''}" >&2`,
      o.tail ?? '',
      `exit ${o.code ?? 0}`,
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, dir, stdin: () => fs.readFileSync(path.join(dir, 'stdin'), 'utf8') };
}

function options(bin: string, dir: string, p: Partial<AgentRunOptions> = {}) {
  const steps: AgentStep[] = [];
  const opts: AgentRunOptions = {
    bin,
    cwd: dir,
    env: process.env,
    prompt: 'задача',
    timeoutMs: 20_000,
    group: `agents-${path.basename(dir)}`,
    onOutput: () => {},
    onStep: (s) => steps.push(s),
    ...p,
  };
  return { opts, steps };
}

test('claudeArgs: изоляция, сессия, инструменты', () => {
  const plain = claudeArgs({});
  assert.ok(plain.includes('--strict-mcp-config'));
  assert.ok(plain.includes('--no-session-persistence'));
  const user = claudeArgs({
    userConfig: true,
    sessionId: 's',
    model: 'opus',
    tools: ['Read', 'Grep'],
    addDirs: ['/a', '/b'],
    partial: true,
  });
  assert.ok(!user.includes('--strict-mcp-config'));
  assert.ok(!user.includes('--no-session-persistence'));
  assert.equal(user[user.indexOf('--session-id') + 1], 's');
  assert.equal(user[user.indexOf('--tools') + 1], 'Read,Grep');
  assert.equal(user.filter((a) => a === '--add-dir').length, 2);
  assert.ok(user.includes('--include-partial-messages'));
  // Продолжение сессии важнее новой.
  const resumed = claudeArgs({ resume: 'r', sessionId: 's' });
  assert.ok(resumed.includes('--resume'));
  assert.ok(!resumed.includes('--session-id'));
});

test('claudeEnv: прокси, собственный вход, ключ из окружения', () => {
  const env = { ANTHROPIC_API_KEY: 'mine', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://x', CLAUDECODE: '1', PATH: '/bin' };
  const proxy = claudeEnv({ env, proxy: PROXY });
  assert.equal(proxy.ANTHROPIC_API_KEY, 'key');
  assert.equal(proxy.ANTHROPIC_BASE_URL, PROXY.baseUrl);
  assert.equal(proxy.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(proxy.CLAUDECODE, undefined);
  const login = claudeEnv({ env });
  assert.equal(login.ANTHROPIC_API_KEY, undefined);
  assert.equal(login.ANTHROPIC_BASE_URL, undefined);
  assert.equal(claudeEnv({ env, claudeAuth: 'env' }).ANTHROPIC_API_KEY, 'mine');
  assert.equal(env.CLAUDECODE, '1', 'исходное окружение не меняется');
});

test('codexProxyBase: /v1 дописывается один раз, явный адрес важнее', () => {
  assert.equal(codexProxyBase(PROXY), 'https://proxy.test/api/v1');
  assert.equal(codexProxyBase({ ...PROXY, baseUrl: 'https://p.test/v2/' }), 'https://p.test/v2');
  assert.equal(codexProxyBase({ ...PROXY, codexBaseUrl: ' https://c.test ' }), 'https://c.test');
});

test('codexArgs: новый запуск и продолжение; промпт из stdin всегда последним', () => {
  const fresh = codexArgs(
    { cwd: '/w', sandbox: 'workspace-write', proxy: PROXY, images: ['/a.png'], model: 'm' },
    { lastFile: '/l', schemaFile: '/s' },
  );
  assert.equal(fresh.at(-1), '-');
  assert.ok(fresh.includes('--ephemeral'));
  assert.ok(fresh.includes('--ignore-user-config'));
  assert.ok(fresh.includes('--image=/a.png'));
  assert.ok(fresh.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(fresh[fresh.indexOf('--output-schema') + 1], '/s');
  assert.equal(fresh[fresh.indexOf('-C') + 1], '/w');

  const resumed = codexArgs({ cwd: '/w', sandbox: 'read-only', resumeThread: 'th', userConfig: true, proxy: PROXY }, { lastFile: '/l' });
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(resumed.slice(-2), ['th', '-']);
  assert.ok(!resumed.includes('-C'));
  assert.ok(!resumed.includes('--ignore-user-config'));
  assert.ok(!resumed.includes('sandbox_workspace_write.network_access=true'));
});

test('addUsage: стоимость остаётся неизвестной, если её не сообщали', () => {
  const a = addUsage(emptyUsage(), { input: 2, output: 3 });
  assert.equal(a.costUsd, undefined);
  const b = addUsage(a, { cacheRead: 1, costUsd: 0.5 });
  assert.deepEqual(b, { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, costUsd: 0.5 });
});

test('clip: короткое как есть, длинное — с пометкой, сколько срезано', () => {
  assert.equal(clip('  abc  '), 'abc');
  assert.match(clip('abcdef', 3), /^abc.*\+3/);
});

test('explainError: типовые сбои и запасной вариант', () => {
  assert.match(explainError('claude', 'Invalid API key', 'login'), /не авторизован/);
  assert.match(explainError('claude', 'HTTP 401', 'env'), /ключ из окружения/);
  assert.match(explainError('claude', 'unauthorized', 'proxy'), /отклонил ключ/);
  assert.match(explainError('claude', 'credit balance is too low'), /кредиты/);
  assert.match(explainError('claude', 'Error 429 Too Many Requests'), /лимит/);
  assert.match(explainError('claude', 'model gpt-x not found'), /модель недоступна/);
  assert.match(explainError('claude', 'getaddrinfo ENOTFOUND'), /соединения/);
  const b64 = 'A'.repeat(200);
  assert.equal(explainError('claude', `${b64}\nсбой один\n${b64}\nсбой два`), 'claude: сбой один сбой два');
  assert.match(explainError('claude', ''), /без сообщения/);
  // Код статуса — отдельным числом, а не цифры внутри порта или номера строки.
  assert.equal(explainError('claude', 'port 4010 busy at line 14290'), 'claude: port 4010 busy at line 14290');
});

test('runClaude: события потока — итог, токены, шаги; промпт через stdin', unix, async (t) => {
  const cli = fakeCli(t, [
    { type: 'system', subtype: 'init', model: 'opus', cwd: '/w' },
    'не JSON — просто строка',
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: ' план ' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts\nлишнее' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ text: 'вывод' }] }] } },
    {
      type: 'result',
      subtype: 'success',
      result: 'готово',
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
      total_cost_usd: 0.25,
    },
  ]);
  const { opts, steps } = options(cli.bin, cli.dir);
  const r = await runClaude(opts);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'готово');
  assert.deepEqual(r.usage, { input: 5, output: 7, cacheRead: 1, cacheWrite: 2, costUsd: 0.25 });
  assert.deepEqual(steps, [
    { kind: 'text', text: 'план' },
    { kind: 'tool', text: 'Read /a.ts' },
  ]);
  assert.equal(cli.stdin(), 'задача');
});

test('runClaude: с partial текст приходит кусками и не дублируется целым сообщением', unix, async (t) => {
  const cli = fakeCli(t, [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'пл' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ан' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'план' }] } },
    { type: 'result', subtype: 'success', result: 'план', usage: {} },
  ]);
  const { opts, steps } = options(cli.bin, cli.dir, { partial: true });
  await runClaude(opts);
  assert.deepEqual(steps, [
    { kind: 'text', text: 'пл', delta: true },
    { kind: 'text', text: 'ан', delta: true },
  ]);
});

test('runClaude: сбои — ошибка в result, выход без result, не запустился', unix, async (t) => {
  const failed = fakeCli(t, [
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'credit balance too low', usage: {} },
  ]);
  const a = await runClaude(options(failed.bin, failed.dir).opts);
  assert.equal(a.ok, false);
  assert.match(a.error ?? '', /кредиты/);

  const silent = fakeCli(t, [], { code: 3 });
  const b = await runClaude(options(silent.bin, silent.dir).opts);
  assert.equal(b.ok, false);
  assert.match(b.error ?? '', /код выхода 3/);

  const crashed = fakeCli(t, [{ type: 'error', message: 'Сбой модели' }, 'B'.repeat(200)], { code: 1 });
  const c = await runClaude(options(crashed.bin, crashed.dir).opts);
  assert.match(c.error ?? '', /Сбой модели/);
  assert.doesNotMatch(c.error ?? '', /BBBB/, 'base64 не вытесняет причину');

  const missing = await runClaude(options(path.join(silent.dir, 'нет'), silent.dir).opts);
  assert.match(missing.error ?? '', /не запустился/);
});

test('runClaude: «Стоп» и зависание', unix, async (t) => {
  const stuck = fakeCli(t, [], { tail: 'exec sleep 30' });
  const stop = options(stuck.bin, stuck.dir);
  const p = runClaude(stop.opts);
  await new Promise((r) => setTimeout(r, 200));
  await killGroup(stop.opts.group);
  const r = await p;
  assert.equal(r.stopped, true);

  const idle = await runClaude(options(stuck.bin, stuck.dir, { idleTimeoutMs: 200 }).opts);
  assert.equal(idle.ok, false);
  assert.equal(idle.stopped, undefined);
  assert.match(idle.error ?? '', /завис/);
});

const codexOpts = (bin: string, dir: string, p: Partial<CodexOptions> = {}) => {
  const { opts, steps } = options(bin, dir);
  const o: CodexOptions = { ...opts, sandbox: 'read-only', ...p };
  return { opts: o, steps };
};

test('runCodex: события потока — ответ, токены, шаги, ID сессии; системный промпт впереди', unix, async (t) => {
  const cli = fakeCli(t, [
    { type: 'thread.started', thread_id: 'th1' },
    { type: 'item.started', item: { type: 'command_execution', command: 'ls\nlong' } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'out', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'готово' } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1, cached_input_tokens: 2 } },
  ]);
  let session = '';
  const { opts, steps } = codexOpts(cli.bin, cli.dir, { systemPrompt: 'СИСТЕМА', onSession: (id) => (session = id) });
  const r = await runCodex(opts);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'готово');
  assert.deepEqual(r.usage, { input: 3, output: 5, cacheRead: 2, cacheWrite: 0, costUsd: undefined });
  assert.equal(session, 'th1');
  assert.deepEqual(steps, [
    { kind: 'tool', text: 'shell ls' },
    { kind: 'tool', text: 'правка a.ts' },
    { kind: 'text', text: 'готово' },
  ]);
  assert.match(cli.stdin(), /^СИСТЕМА\n\n---\n\nзадача$/);
});

test('runCodex: сбои — turn.failed без ответа, ненулевой код, не запустился', unix, async (t) => {
  const failed = fakeCli(t, [{ type: 'turn.failed', error: { message: 'model xyz not found' } }]);
  const a = await runCodex(codexOpts(failed.bin, failed.dir).opts);
  assert.equal(a.ok, false);
  assert.match(a.error ?? '', /модель недоступна/);

  const noisy = fakeCli(t, [
    { type: 'error', message: 'временный сбой' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'всё же готово' } },
  ]);
  assert.equal((await runCodex(codexOpts(noisy.bin, noisy.dir).opts)).ok, true, 'ошибка в потоке при готовом ответе — не провал');

  const code = fakeCli(t, [], { code: 2, stderr: 'паника' });
  const b = await runCodex(codexOpts(code.bin, code.dir).opts);
  assert.match(b.error ?? '', /паника/);

  const missing = await runCodex(codexOpts(path.join(code.dir, 'нет'), code.dir).opts);
  assert.match(missing.error ?? '', /не запустился/);
});

test('runCodex: без прокси сбой авторизации не сваливается на прокси PurpleSchool', unix, async (t) => {
  const cli = fakeCli(t, [], { code: 1, stderr: '401 Unauthorized' });
  const own = await runCodex(codexOpts(cli.bin, cli.dir).opts);
  assert.doesNotMatch(own.error ?? '', /прокси/);
  assert.match(own.error ?? '', /не авторизован/);
  const proxied = await runCodex(codexOpts(cli.bin, cli.dir, { proxy: PROXY }).opts);
  assert.match(proxied.error ?? '', /отклонил ключ/);
});

test('claudeInput: на Windows системный промпт — в stdin, в cmd.exe аргумент с переводом строки оборвал бы команду', () => {
  const o = { prompt: 'задача', systemPrompt: 'строка 1\nстрока 2' };
  assert.deepEqual(claudeInput(o, 'darwin'), o);
  const win = claudeInput(o, 'win32');
  assert.equal(win.systemPrompt, undefined);
  assert.match(win.prompt, /^строка 1\nстрока 2[\s\S]*задача$/);
  assert.deepEqual(claudeInput({ prompt: 'задача' }, 'win32'), { prompt: 'задача', systemPrompt: undefined });
});
