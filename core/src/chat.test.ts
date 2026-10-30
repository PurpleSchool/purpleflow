import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orchestrator, type CoreSettings } from './orchestrator.js';
import { claudeArgs } from './agents/claude.js';
import { codexArgs } from './agents/codex.js';
import { emptyUsage, type AgentRunOptions } from './agents/common.js';
import type { ChatFile, CoreEvent } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** Ядро с «установленными» claude и codex (скрипты отвечают версией) и подменёнными запусками. */
function makeCore(runners: { claude?: unknown; codex?: unknown }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-bin-'));
  for (const n of ['codex', 'claude']) fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "${n} 1.0.0"\n`, { mode: 0o755 });
  const settings = {
    toolPaths: { codex: path.join(bin, 'codex'), claude: path.join(bin, 'claude') }, proxy: { baseUrl: '', apiKey: '' },
    models: { planner: 'opus', executor: 'sonnet', reviewer: '' }, agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
    agentTimeoutMin: 5, testTimeoutMin: 2, maxParallel: 2,
  } as unknown as CoreSettings;
  const core = new Orchestrator({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-data-')), promptsDir: PROMPTS, env: process.env, getSettings: () => settings, runners: runners as never });
  return core;
}

/** Ждём, пока ход чата закончится. */
async function untilIdle(core: Orchestrator, id: string): Promise<ChatFile> {
  for (let i = 0; i < 200; i++) {
    const c = core.getChat(id)!;
    if (!c.busy && !c.chat.messages.some((m) => m.pending)) return c.chat;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('ход чата не закончился');
}

test('чат на claude: ответ кусками, шаги инструментов, продолжение сессии во втором ходе', async () => {
  const calls: AgentRunOptions[] = [];
  const claude = async (o: AgentRunOptions) => {
    calls.push(o);
    o.onStep?.({ kind: 'text', text: 'При', delta: true });
    o.onStep?.({ kind: 'text', text: 'вет', delta: true });
    o.onStep?.({ kind: 'tool', text: 'Read src/a.ts' });
    o.onStep?.({ kind: 'text', text: 'Готово', delta: true });
    return { ok: true, text: 'Готово', usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  const events: CoreEvent[] = [];
  core.on((e) => events.push(e));

  const chat = await core.createChat({ agent: 'claude' });
  assert.equal(chat.edits, true);
  await core.sendChat(chat.id, 'Как устроен проект?');
  const after = await untilIdle(core, chat.id);

  assert.equal(after.title, 'Как устроен проект?');
  const answer = after.messages.at(-1)!;
  assert.equal(answer.role, 'assistant');
  assert.deepEqual(answer.parts, [{ kind: 'text', text: 'Привет' }, { kind: 'tool', text: 'Read src/a.ts' }, { kind: 'text', text: 'Готово' }]);
  assert.equal(answer.text, 'Привет\n\nГотово');
  assert.ok(events.some((e) => e.type === 'chat.updated'));
  // Первый ход — новая сессия с системным промптом, модель — как у первой роли claude.
  assert.ok(calls[0].sessionId && !calls[0].resume);
  assert.match(calls[0].systemPrompt ?? '', /чате PurpleFlow/);
  assert.equal(calls[0].model, 'sonnet');
  assert.equal(calls[0].partial, true);
  assert.equal(calls[0].tools, undefined, 'с правками инструменты не ограничены');

  await core.sendChat(chat.id, 'А тесты где?');
  await untilIdle(core, chat.id);
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.equal(calls[1].systemPrompt, undefined);
  assert.doesNotMatch(calls[1].prompt, /Предыдущая переписка/);

  assert.deepEqual(core.listChats().map((c) => c.id), [chat.id]);
});

test('чат: только чтение, смена агента пересказывает историю, ошибка и удаление', async () => {
  const claudeCalls: AgentRunOptions[] = [];
  const codexCalls: (AgentRunOptions & { sandbox: string; resumeThread?: string; persist?: boolean })[] = [];
  const claude = async (o: AgentRunOptions) => { claudeCalls.push(o); o.onStep?.({ kind: 'text', text: 'Ответ claude', delta: true }); return { ok: true, text: 'Ответ claude', usage: emptyUsage() }; };
  const codex = async (o: AgentRunOptions & { sandbox: string }) => {
    codexCalls.push(o);
    o.onSession?.('thread-1');
    if (codexCalls.length === 2) return { ok: false, text: '', usage: emptyUsage(), error: 'codex: сбой' };
    o.onStep?.({ kind: 'text', text: 'Ответ codex' });
    return { ok: true, text: 'Ответ codex', usage: emptyUsage() };
  };
  const core = makeCore({ claude, codex });
  const chat = await core.createChat({ agent: 'claude', edits: false });
  await core.sendChat(chat.id, 'Первый вопрос');
  await untilIdle(core, chat.id);
  assert.deepEqual(claudeCalls[0].tools, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);

  core.updateChat(chat.id, { agent: 'codex' });
  await core.sendChat(chat.id, 'Второй вопрос');
  await untilIdle(core, chat.id);
  assert.equal(codexCalls[0].sandbox, 'read-only');
  assert.equal(codexCalls[0].persist, true);
  assert.equal(codexCalls[0].resumeThread, undefined);
  assert.match(codexCalls[0].prompt, /Предыдущая переписка[\s\S]*Первый вопрос[\s\S]*Ответ claude/);

  await core.sendChat(chat.id, 'Третий вопрос');
  const after = await untilIdle(core, chat.id);
  assert.equal(codexCalls[1].resumeThread, 'thread-1');
  assert.equal(after.messages.at(-1)!.error, 'codex: сбой');

  await assert.rejects(core.sendChat(chat.id, '   '), /Пустое сообщение/);
  await core.deleteChat(chat.id);
  assert.equal(core.getChat(chat.id), null);
});

test('чат с правками в git-репозитории: ответ перечисляет изменённые за ход файлы', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-chat-repo-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'старая правка\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'изменён до хода\n');
  const claude = async (o: AgentRunOptions) => {
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(o.cwd, 'a.txt'), 'b\n');
    fs.writeFileSync(path.join(o.cwd, 'new.txt'), 'новый\n');
    return { ok: true, text: 'Поправил', usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  const chat = await core.createChat({ agent: 'claude', projectPath: repo });
  await core.sendChat(chat.id, 'Поправь a.txt');
  const after = await untilIdle(core, chat.id);
  assert.deepEqual(after.messages.at(-1)!.changedFiles?.sort(), ['a.txt', 'new.txt']);
  assert.equal(after.messages.at(-1)!.text, 'Поправил');
  // Вкладка «Код» чата — все незакоммиченные изменения проекта, включая сделанные до хода.
  const diff = await core.getChatDiff(chat.id);
  assert.deepEqual(diff.map((f) => f.path).sort(), ['a.txt', 'new.txt', 'old.txt']);
  assert.deepEqual((await core.getChatChangedFiles(chat.id)).sort(), ['a.txt', 'new.txt', 'old.txt']);
  await assert.rejects(core.startPreview(chat.id), /Запуск приложения/);
});

test('аргументы CLI для чата: частичные сообщения claude и продолжение сессии codex', () => {
  assert.ok(claudeArgs({ partial: true }).includes('--include-partial-messages'));
  assert.ok(!claudeArgs({}).includes('--include-partial-messages'));

  const first = codexArgs({ cwd: '/p', sandbox: 'workspace-write', persist: true }, { lastFile: '/t/last' });
  assert.ok(!first.includes('--ephemeral'));
  assert.deepEqual(first.slice(0, 2), ['exec', '--json']);
  assert.equal(first.at(-1), '-');

  const next = codexArgs({ cwd: '/p', sandbox: 'read-only', resumeThread: 'abc', model: 'gpt-6-sol' }, { lastFile: '/t/last' });
  assert.deepEqual(next.slice(0, 3), ['exec', 'resume', '--json']);
  assert.ok(next.includes('sandbox_mode="read-only"'));
  assert.ok(!next.includes('-C') && !next.includes('-s'));
  assert.deepEqual(next.slice(-4), ['-o', '/t/last', 'abc', '-']);

  const ephemeral = codexArgs({ cwd: '/p', sandbox: 'read-only' }, { lastFile: '/t/last' });
  assert.ok(ephemeral.includes('--ephemeral'));
});

test('чат: сообщение во время ответа встаёт в очередь и уходит следующим ходом; прерванный ответ, удаление из очереди', async () => {
  const calls: AgentRunOptions[] = [];
  const gates: ((r: { stopped?: boolean }) => void)[] = [];
  const claude = async (o: AgentRunOptions) => {
    calls.push(o);
    o.onStep?.({ kind: 'text', text: `ответ ${calls.length}`, delta: true });
    const r = await new Promise<{ stopped?: boolean }>((res) => gates.push(res));
    return r.stopped ? { ok: false, stopped: true, text: '', usage: emptyUsage() } : { ok: true, text: `ответ ${calls.length}`, usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  const chat = await core.createChat({ agent: 'claude' });
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(pred(), 'не дождались');
  };

  await core.sendChat(chat.id, 'Прогони тесты');
  await until(() => gates.length === 1);
  // Агент отвечает — два уточнения встают в очередь, третье человек убирает.
  await core.sendChat(chat.id, 'Только один тест');
  await core.sendChat(chat.id, 'math.test.js');
  await core.sendChat(chat.id, 'лишнее');
  let c = core.getChat(chat.id)!;
  assert.equal(c.busy, true);
  assert.deepEqual(c.chat.messages.filter((m) => m.queued).map((m) => m.text), ['Только один тест', 'math.test.js', 'лишнее']);
  core.unqueueChat(chat.id, c.chat.messages.at(-1)!.id);
  assert.throws(() => core.unqueueChat(chat.id, c.chat.messages[0].id), /уже ушло/);

  // Ответ прерван — очередь уходит одним ходом, агент знает, что его прервали.
  gates[0]({ stopped: true });
  await until(() => gates.length === 2);
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.equal(calls[1].prompt, 'Я прервал твой предыдущий ответ.\n\nТолько один тест\n\nmath.test.js');
  c = core.getChat(chat.id)!;
  assert.deepEqual(c.chat.messages.map((m) => (m.pending ? `${m.role}:…` : `${m.role}:${m.text}${m.queued ? ':q' : ''}${m.stopped ? ':stopped' : ''}`)),
    ['user:Прогони тесты', 'assistant:ответ 1:stopped', 'user:Только один тест', 'user:math.test.js', 'assistant:…']);

  gates[1]({});
  await untilIdle(core, chat.id);
  assert.equal(calls.length, 2);
  c = core.getChat(chat.id)!;
  assert.equal(c.busy, false);
  assert.equal(c.chat.messages.at(-1)!.text, 'ответ 2');
});
