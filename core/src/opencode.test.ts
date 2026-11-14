import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeStream, openCodeArgs, openCodeEnv, runOpenCode, type OpenCodeOptions } from './agents/opencode.js';
import { emptyUsage, type AgentStep } from './agents/common.js';
import { killGroup } from './proc.js';
import { Orchestrator } from './orchestrator.js';
import type { CoreSettings } from './types.js';
import { parseOpenCodeModels } from './services/models.js';

test('OpenCode: каталог сохраняет вложенные ID, удаляет дубли и пропускает сообщения CLI', () => {
  assert.deepEqual(
    parseOpenCodeModels('provider/model\r\nrouter/vendor/model:free\nprovider/model\nLoading plugins...\n\nlocal/model#high\n'),
    ['provider/model', 'router/vendor/model:free', 'local/model#high'],
  );
  assert.deepEqual(parseOpenCodeModels(''), []);
});

test('OpenCode: аргументы, PWD и разрешения чтения сохраняют конфигурацию провайдера', () => {
  assert.deepEqual(openCodeArgs({ model: ' vendor/model#high ', resume: 'ses_1', readOnly: true, images: ['C:/a b.png'] }), [
    '--standalone',
    'run',
    '--format',
    'json',
    '--thinking',
    '--auto',
    '--model',
    'vendor/model#high',
    '--session',
    'ses_1',
    '--agent',
    'purpleflow-readonly',
    '--file=C:/a b.png',
  ]);
  const config = { providers: { local: { name: 'Local' } }, agents: { custom: { description: 'Свой агент' } } };
  const env = { PWD: '/wrong', OPENCODE_CONFIG_CONTENT: JSON.stringify(config), ELECTRON_RUN_AS_NODE: '1' };
  const result = openCodeEnv({ env, cwd: '/project', readOnly: true });
  const merged = JSON.parse(result.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(merged.providers, config.providers);
  assert.deepEqual(merged.agents.custom, config.agents.custom);
  const rules = merged.agents['purpleflow-readonly'].permissions as { action: string; effect: string }[];
  for (const action of ['shell', 'edit', 'subagent', 'execute', 'mcp.write'])
    assert.equal([...rules].reverse().find((r) => r.action === '*' || r.action === action)?.effect, 'deny');
  assert.equal([...rules].reverse().find((r) => r.action === 'read')?.effect, 'allow');
  assert.equal(result.PWD, '/project');
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PWD, '/wrong');
});

test('OpenCode: текст, инструменты, вложенные метаданные, расход и ошибка после ответа', () => {
  const steps: AgentStep[] = [];
  const sessions: string[] = [];
  const stream = new OpenCodeStream({ onOutput: () => {}, onStep: (s) => steps.push(s), onSession: (s) => sessions.push(s) });
  const send = (type: string, part: object, sessionID = 'ses_1') => stream.accept(JSON.stringify({ type, part, sessionID }));
  stream.accept('не JSON');
  stream.accept('null');
  send('text', { messageID: 'm1', text: 'Проверю' });
  send('text', { messageID: 'child', text: 'Чужой ответ' }, 'ses_child');
  send('reasoning', { text: 'Анализ' });
  const tool = {
    id: 'call_1',
    tool: 'shell',
    state: { status: 'completed', input: { command: 'npm test' }, metadata: { metadata: { exit: 1, output: 'FAIL' } } },
  };
  send('tool_use', tool);
  send('tool_use', tool);
  const finish = { id: 'p1', messageID: 'm1', tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, cost: 0.01 };
  send('step_finish', finish);
  send('step_finish', finish);
  send('text', { messageID: 'm2', text: 'Го' });
  send('text', { messageID: 'm2', text: 'тово' });
  send('step_finish', { id: 'p2', messageID: 'm2', tokens: { input: 20, output: 5 }, cost: 0.02 });
  assert.equal(stream.answer, 'Готово');
  assert.deepEqual(sessions, ['ses_1']);
  assert.deepEqual(stream.usage, { input: 30, output: 10, cacheRead: 4, cacheWrite: 5, costUsd: 0.03 });
  assert.equal(steps.filter((s) => s.kind === 'tool').length, 1);
  assert.deepEqual(
    steps.find((s) => s.kind === 'tool_result'),
    { kind: 'tool_result', id: 'call_1', ok: false, output: 'FAIL' },
  );
  stream.accept(JSON.stringify({ type: 'error', error: { type: 'ProviderError', message: 'Нет ключа' } }));
  assert.equal(stream.error, 'Нет ключа');
});

/** Настоящий дочерний процесс без провайдера, одинаковый протокол на Windows и Unix. */
function fixture(dir: string, body: string): string {
  const script = path.join(dir, 'fake.cjs');
  fs.writeFileSync(script, body);
  const bin = path.join(dir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  fs.writeFileSync(
    bin,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

test('OpenCode: stdin, ошибка протокола, таймаут и остановка группы', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-opencode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base: OpenCodeOptions = {
    bin: '',
    cwd: dir,
    env: process.env,
    prompt: 'Привет\n"мир" & more',
    timeoutMs: 5000,
    group: 'opencode-fixture',
    onOutput: () => {},
  };
  const bin = fixture(
    dir,
    `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input+=x); process.stdin.on('end', () => {
    console.log(JSON.stringify({type:'text',sessionID:'ses_test',part:{messageID:'m',text:input}}));
    console.log(JSON.stringify({type:'step_finish',sessionID:'ses_test',part:{messageID:'m',tokens:{output:1}}}));
  });`,
  );
  const ok = await runOpenCode({ ...base, bin });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, base.prompt);
  fixture(dir, `console.log(JSON.stringify({type:'error',error:{message:'Нет ключа'}}));`);
  assert.match((await runOpenCode({ ...base, bin })).error!, /Нет ключа/);
  fixture(dir, `console.log('{}');`);
  assert.match((await runOpenCode({ ...base, bin })).error!, /без step_finish/);
  fixture(dir, `setInterval(() => {}, 1000);`);
  const timeout = await runOpenCode({ ...base, bin, idleTimeoutMs: 200 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.stopped, undefined);
  fixture(dir, `console.log('ready'); setInterval(() => {}, 1000);`);
  const stopped = await runOpenCode({
    ...base,
    bin,
    onOutput: () => {
      void killGroup(base.group);
    },
  });
  assert.equal(stopped.stopped, true);
});

test('OpenCode: чат сохраняет сессию, возобновляет её и сбрасывает при смене прав', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-opencode-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls: OpenCodeOptions[] = [];
  const settings: CoreSettings = {
    toolPaths: { opencode: process.execPath },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: 'vendor/model', reviewer: '' },
    agents: { planner: 'opencode', executor: 'opencode', reviewer: 'opencode' },
    claudeAuth: 'login',
    agentTimeoutMin: 1,
    testTimeoutMin: 1,
  };
  const core = new Orchestrator({
    dataDir: dir,
    promptsDir: fileURLToPath(new URL('../prompts', import.meta.url)),
    env: process.env,
    getSettings: () => settings,
    runners: {
      opencode: async (o) => {
        calls.push(o);
        o.onSession?.('ses_chat');
        o.onStep?.({ kind: 'text', text: 'Ответ' });
        return { ok: true, text: 'Ответ', usage: emptyUsage() };
      },
    },
  });
  const chat = await core.createChat({ agent: 'opencode', edits: false });
  const send = async (text: string) => {
    await core.sendChat(chat.id, text);
    for (let i = 0; i < 200; i++) {
      const current = (await core.getChat(chat.id))!;
      if (!current.busy && !current.chat.messages.some((m) => m.pending)) return current.chat;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Чат не завершился');
  };
  const first = await send('Первый вопрос');
  assert.deepEqual(first.session, { agent: 'opencode', id: 'ses_chat' });
  assert.equal(calls[0].readOnly, true);
  assert.equal(calls[0].model, 'vendor/model');
  await send('Второй вопрос');
  assert.equal(calls[1].resume, 'ses_chat');
  assert.equal(calls[1].systemPrompt, undefined);
  await core.updateChat(chat.id, { edits: true });
  await send('Теперь с правками');
  assert.equal(calls[2].resume, undefined);
  assert.equal(calls[2].readOnly, false);
  assert.match(calls[2].prompt, /Предыдущая переписка/);
});
