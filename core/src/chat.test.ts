import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.js';
import { setChatWebBridge } from './webbridge.js';
import { cleanTitle, wantsImage } from './services/chat.js';
import type { CoreSettings } from './types.js';
import { claudeArgs } from './agents/claude.js';
import { codexArgs } from './agents/codex.js';
import { emptyUsage, type AgentRunOptions } from './agents/common.js';
import type { AgyOptions } from './agents/agy.js';
import type { ChatFile, CoreEvent } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** Ядро с «установленными» claude и codex (скрипты отвечают версией) и подменёнными запусками. */
function makeCore(
  runners: { claude?: unknown; codex?: unknown; agy?: unknown },
  o: { chatTitles?: boolean; browser?: boolean; settings?: Partial<CoreSettings> } = {},
) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-bin-'));
  for (const n of ['codex', 'claude', 'agy']) fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "${n} 1.0.0"\n`, { mode: 0o755 });
  const settings = {
    toolPaths: { codex: path.join(bin, 'codex'), claude: path.join(bin, 'claude'), agy: path.join(bin, 'agy') },
    enabledAgents: ['claude', 'codex', 'agy'],
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: 'opus', executor: 'sonnet', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
    agentTimeoutMin: 5,
    testTimeoutMin: 2,
    maxParallel: 2,
    ...o.settings,
  } as unknown as CoreSettings;
  const core = new Orchestrator({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-data-')),
    promptsDir: PROMPTS,
    // Браузер чата (Playwright) в тестах не запускаем — кроме проверки самого браузера.
    env: { ...process.env, PURPLEFLOW_CHAT_BROWSER: o.browser ? 'on' : 'off' },
    getSettings: () => settings,
    runners: runners as never,
    chatTitles: o.chatTitles ?? false,
  });
  return core;
}

/** Ждём, пока ход чата закончится. */
async function untilIdle(core: Orchestrator, id: string): Promise<ChatFile> {
  for (let i = 0; i < 200; i++) {
    const c = (await core.getChat(id))!;
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
    o.onStep?.({ kind: 'meta', model: 'claude-sonnet', cwd: '/w', mcp: [{ name: 'gh', status: 'connected' }] });
    o.onStep?.({ kind: 'meta', context: 42_000 });
    o.onStep?.({ kind: 'meta', contextWindow: 200_000 });
    return { ok: true, text: 'Готово', usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  // Модель по умолчанию — как у первой роли этого агента; у codex в настройках пусто — решает CLI.
  assert.equal(await core.chatDefaultModel('claude'), 'sonnet');
  assert.equal(await core.chatDefaultModel('codex'), '');
  const events: CoreEvent[] = [];
  core.on((e) => events.push(e));

  const chat = await core.createChat({ agent: 'claude' });
  assert.equal(chat.edits, true);
  await core.sendChat(chat.id, 'Как устроен проект?');
  const after = await untilIdle(core, chat.id);

  assert.equal(after.title, 'Как устроен проект?');
  const answer = after.messages.at(-1)!;
  assert.equal(answer.role, 'assistant');
  assert.deepEqual(answer.parts, [
    { kind: 'text', text: 'Привет' },
    { kind: 'tool', text: 'Read src/a.ts' },
    { kind: 'text', text: 'Готово' },
  ]);
  assert.equal(answer.text, 'Привет\n\nГотово');
  assert.equal(answer.model, 'claude-sonnet');
  assert.deepEqual(answer.info, { cwd: '/w', mcp: [{ name: 'gh', status: 'connected' }], context: 42_000, contextWindow: 200_000 });
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

  assert.deepEqual(
    (await core.listChats()).map((c) => c.id),
    [chat.id],
  );
});

test('чат: только чтение, смена агента пересказывает историю, ошибка и удаление', async () => {
  const claudeCalls: AgentRunOptions[] = [];
  const codexCalls: (AgentRunOptions & { sandbox: string; resumeThread?: string; persist?: boolean })[] = [];
  const claude = async (o: AgentRunOptions) => {
    claudeCalls.push(o);
    o.onStep?.({ kind: 'text', text: 'Ответ claude', delta: true });
    return { ok: true, text: 'Ответ claude', usage: emptyUsage() };
  };
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

  await core.updateChat(chat.id, { agent: 'codex' });
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
  assert.equal(await core.getChat(chat.id), null);
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

test('claude в правках чата: песочница bash с закрытым .git — одним --settings вместе с настройками пользователя', () => {
  const settingsOf = (a: string[]) => a.filter((_, i) => a[i - 1] === '--settings').map((x) => JSON.parse(x));
  assert.deepEqual(settingsOf(claudeArgs({})), []);
  const [own] = settingsOf(claudeArgs({ sandbox: '/p' }));
  assert.equal(own.sandbox.enabled, true);
  assert.equal(own.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(own.sandbox.filesystem.denyWrite, [path.join('/p', '.git')]);
  const both = settingsOf(claudeArgs({ sandbox: '/p', userConfig: true }));
  assert.equal(both.length, 1);
  assert.equal(both[0].disableAllHooks, true);
  assert.equal(both[0].sandbox.enabled, true);
});

test('чат: сообщение во время ответа встаёт в очередь и уходит следующим ходом; прерванный ответ, удаление из очереди', async () => {
  const calls: AgentRunOptions[] = [];
  const gates: ((r: { stopped?: boolean }) => void)[] = [];
  const claude = async (o: AgentRunOptions) => {
    calls.push(o);
    o.onStep?.({ kind: 'text', text: `ответ ${calls.length}`, delta: true });
    const r = await new Promise<{ stopped?: boolean }>((res) => gates.push(res));
    return r.stopped
      ? { ok: false, stopped: true, text: '', usage: emptyUsage() }
      : { ok: true, text: `ответ ${calls.length}`, usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  const chat = await core.createChat({ agent: 'claude' });
  const until = async (pred: () => boolean) => {
    // Запас по времени: при полном прогоне набора машина занята, и ожидание в 2 с проваливалось.
    for (let i = 0; i < 1500 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(pred(), 'не дождались');
  };

  await core.sendChat(chat.id, 'Прогони тесты');
  await until(() => gates.length === 1);
  // Агент отвечает — два уточнения встают в очередь, третье человек убирает.
  await core.sendChat(chat.id, 'Только один тест');
  await core.sendChat(chat.id, 'math.test.js');
  await core.sendChat(chat.id, 'лишнее');
  let c = (await core.getChat(chat.id))!;
  assert.equal(c.busy, true);
  assert.deepEqual(
    c.chat.messages.filter((m) => m.queued).map((m) => m.text),
    ['Только один тест', 'math.test.js', 'лишнее'],
  );
  await core.unqueueChat(chat.id, c.chat.messages.at(-1)!.id);
  await assert.rejects(core.unqueueChat(chat.id, c.chat.messages[0].id), /уже ушло/);

  // Ответ прерван — очередь уходит одним ходом, агент знает, что его прервали.
  gates[0]({ stopped: true });
  await until(() => gates.length === 2);
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.equal(calls[1].prompt, 'Я прервал твой предыдущий ответ.\n\nТолько один тест\n\nmath.test.js');
  c = (await core.getChat(chat.id))!;
  assert.deepEqual(
    c.chat.messages.map((m) => (m.pending ? `${m.role}:…` : `${m.role}:${m.text}${m.queued ? ':q' : ''}${m.stopped ? ':stopped' : ''}`)),
    ['user:Прогони тесты', 'assistant:ответ 1:stopped', 'user:Только один тест', 'user:math.test.js', 'assistant:…'],
  );

  gates[1]({});
  await untilIdle(core, chat.id);
  assert.equal(calls.length, 2);
  c = (await core.getChat(chat.id))!;
  assert.equal(c.busy, false);
  assert.equal(c.chat.messages.at(-1)!.text, 'ответ 2');
});

test('чат: смена правок и упавшее продолжение начинают новую сессию', async () => {
  const calls: AgentRunOptions[] = [];
  let fail = false;
  const claude = async (o: AgentRunOptions) => {
    calls.push(o);
    return fail
      ? { ok: false, text: '', error: 'No conversation found', usage: emptyUsage() }
      : { ok: true, text: 'Да', usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  const chat = await core.createChat({ agent: 'claude' });
  await core.sendChat(chat.id, 'Первое');
  await untilIdle(core, chat.id);

  // В только чтение: правила и инструменты другие, продолжать старую сессию нельзя.
  await core.updateChat(chat.id, { edits: false });
  await core.sendChat(chat.id, 'Второе');
  await untilIdle(core, chat.id);
  assert.equal(calls[1].resume, undefined);
  assert.match(calls[1].systemPrompt ?? '', /чате PurpleFlow/);
  assert.match(calls[1].prompt, /Предыдущая переписка/);

  // То же значение — сессия живёт дальше.
  await core.updateChat(chat.id, { edits: false });
  await core.sendChat(chat.id, 'Третье');
  await untilIdle(core, chat.id);
  assert.ok(calls[2].resume);

  // Сессия истекла: один отказ, дальше чат оживает с пересказом истории.
  fail = true;
  await core.sendChat(chat.id, 'Четвёртое');
  const failed = await untilIdle(core, chat.id);
  assert.equal(failed.messages.at(-1)!.error, 'No conversation found');
  fail = false;
  await core.sendChat(chat.id, 'Пятое');
  await untilIdle(core, chat.id);
  assert.equal(calls[4].resume, undefined);
  assert.match(calls[4].prompt, /Предыдущая переписка/);
});

test('чат: три режима — песочница codex и claude, полный доступ без неё; смена режима начинает новую сессию', async () => {
  const claudeCalls: AgentRunOptions[] = [];
  const codexCalls: (AgentRunOptions & { sandbox: string; resumeThread?: string })[] = [];
  const claude = async (o: AgentRunOptions) => {
    claudeCalls.push(o);
    return { ok: true, text: 'Да', usage: emptyUsage() };
  };
  const codex = async (o: AgentRunOptions & { sandbox: string }) => {
    codexCalls.push(o);
    o.onSession?.('thread-1');
    return { ok: true, text: 'Да', usage: emptyUsage() };
  };
  const core = makeCore({ claude, codex });
  const chat = await core.createChat({ agent: 'codex' });
  assert.equal(chat.fullAccess, undefined);
  const turn = async (t: string) => {
    await core.sendChat(chat.id, t);
    await untilIdle(core, chat.id);
  };

  await turn('Правки');
  assert.equal(codexCalls[0].sandbox, 'workspace-write');
  assert.match(codexCalls[0].systemPrompt ?? '', /Полный доступ/);

  // Полный доступ: без песочницы, свои правила — значит, новая сессия.
  await core.updateChat(chat.id, { fullAccess: true });
  await turn('Закоммить');
  assert.equal(codexCalls[1].sandbox, 'danger-full-access');
  assert.equal(codexCalls[1].resumeThread, undefined);
  assert.match(codexCalls[1].systemPrompt ?? '', /полного доступа/);

  // Вопросы снимают и полный доступ.
  const ro = await core.updateChat(chat.id, { edits: false });
  assert.equal(ro.fullAccess, undefined);
  await turn('Вопрос');
  assert.equal(codexCalls[2].sandbox, 'read-only');

  // claude: в правках bash в песочнице папки чата, в полном доступе — без неё.
  await core.updateChat(chat.id, { agent: 'claude', edits: true });
  await turn('Правка');
  assert.ok(claudeCalls[0].sandbox);
  await core.updateChat(chat.id, { fullAccess: true });
  await turn('Ещё');
  assert.equal(claudeCalls[1].sandbox, undefined);
  assert.equal(claudeCalls[1].resume, undefined);
});

test('чат: отказ песочницы помечается в вызове; полный доступ по запросу — новая сессия и просьба повторить', async () => {
  const calls: (AgentRunOptions & { sandbox: string; resumeThread?: string })[] = [];
  const codex = async (o: AgentRunOptions & { sandbox: string }) => {
    calls.push(o);
    o.onSession?.('thread-1');
    o.onStep?.({ kind: 'tool', id: 'c1', text: 'shell git commit' });
    o.onStep?.({ kind: 'tool_result', id: 'c1', ok: false, output: "fatal: Unable to create '.git/index.lock': Operation not permitted" });
    // opencode: команду запретило правило permission.bash.
    o.onStep?.({ kind: 'tool', id: 'c3', text: 'bash kill 42' });
    o.onStep?.({
      kind: 'tool_result',
      id: 'c3',
      ok: false,
      output:
        'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules […]',
    });
    o.onStep?.({ kind: 'tool', id: 'c2', text: 'shell ls' });
    o.onStep?.({ kind: 'tool_result', id: 'c2', ok: true, output: 'a.txt' });
    return { ok: true, text: 'Не получилось', usage: emptyUsage() };
  };
  const core = makeCore({ codex });
  const chat = await core.createChat({ agent: 'codex' });
  await core.sendChat(chat.id, 'Закоммить');
  const first = await untilIdle(core, chat.id);
  const tools = first.messages.at(-1)!.parts!.filter((p) => p.kind === 'tool');
  assert.deepEqual(
    tools.map((t) => t.sandboxDenied),
    [true, true, undefined],
  );

  await core.grantChatFullAccess(chat.id);
  const after = await untilIdle(core, chat.id);
  assert.equal(after.fullAccess, true);
  assert.equal(calls[1].sandbox, 'danger-full-access');
  assert.equal(calls[1].resumeThread, undefined);
  assert.match(calls[1].prompt, /Включил полный доступ/);
});

test('чат: codex не прислал вызов, но просит полный доступ текстом — ответ помечен только в режиме правок', async () => {
  // Так ведёт себя codex 0.172: команду, которую не пустила песочница, событием не присылает — только текст ответа.
  const codex = async (o: AgentRunOptions) => {
    o.onStep?.({
      kind: 'text',
      text: 'Не удалось создать коммит: песочница запретила запись в .git/index.lock. Для этого нужен режим «Полный доступ».',
    });
    return { ok: true, text: '', usage: emptyUsage() };
  };
  const core = makeCore({ codex });
  const chat = await core.createChat({ agent: 'codex' });
  const last = async () => {
    await core.sendChat(chat.id, 'Сделай коммит');
    return (await untilIdle(core, chat.id)).messages.at(-1)!;
  };
  assert.equal((await last()).needsFullAccess, true);
  await core.updateChat(chat.id, { fullAccess: true });
  assert.equal((await last()).needsFullAccess, undefined);
  await core.updateChat(chat.id, { edits: false });
  assert.equal((await last()).needsFullAccess, undefined);
});

test('чат: два вложения с одним именем не затирают друг друга', async () => {
  const seen: AgentRunOptions[] = [];
  const core = makeCore({
    claude: async (o: AgentRunOptions) => {
      seen.push(o);
      return { ok: true, text: 'Да', usage: emptyUsage() };
    },
  });
  const chat = await core.createChat({ agent: 'claude' });
  const data = new Uint8Array([1]);
  await core.sendChat(chat.id, 'Смотри', [
    { name: 'a.png', data },
    { name: 'a.png', data },
  ]);
  const after = await untilIdle(core, chat.id);
  const files = after.messages.find((m) => m.role === 'user')!.attachments ?? [];
  assert.equal(new Set(files).size, 2);
});

test('чат: субагент, итоги вызовов, план, уведомления и итоги хода сохраняются в ответе; прерванный вызов не висит', async () => {
  let stop = false;
  const claude = async (o: AgentRunOptions) => {
    o.onStep?.({ kind: 'meta', model: 'claude-x' });
    o.onStep?.({ kind: 'notice', level: 'warn', key: 'retry', text: 'Повтор 1' });
    o.onStep?.({ kind: 'notice', level: 'warn', key: 'retry', text: 'Повтор 2' });
    o.onStep?.({ kind: 'tool', id: 'ag', text: 'Субагент: поиск' });
    o.onStep?.({ kind: 'tool', id: 's1', parent: 'ag', text: 'Grep foo' });
    o.onStep?.({ kind: 'tool_result', id: 's1', parent: 'ag', ok: true });
    o.onStep?.({ kind: 'tool_result', id: 'ag', ok: true, output: 'нашёл' });
    o.onStep?.({ kind: 'todos', items: [{ text: 'Поправить', status: 'in_progress' }] });
    o.onStep?.({ kind: 'tool', id: 'b', text: 'Bash npm test' });
    if (stop) return { ok: false, stopped: true, text: '', usage: emptyUsage() };
    o.onStep?.({ kind: 'tool_result', id: 'b', ok: false, output: 'FAIL' });
    o.onStep?.({ kind: 'text', text: 'Тест падает', delta: true, fresh: true });
    o.onStep?.({ kind: 'meta', turns: 4, durationMs: 3000 });
    return { ok: true, text: 'Тест падает', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } };
  };
  const core = makeCore({ claude });
  const chat = await core.createChat({ agent: 'claude' });
  await core.sendChat(chat.id, 'Почему падает тест?');
  const answer = (await untilIdle(core, chat.id)).messages.at(-1)!;
  assert.deepEqual(answer.parts, [
    { kind: 'notice', level: 'warn', key: 'retry', text: 'Повтор 2' },
    { kind: 'tool', id: 'ag', text: 'Субагент: поиск', status: 'ok', output: 'нашёл', sub: [{ id: 's1', text: 'Grep foo', status: 'ok' }] },
    { kind: 'todos', items: [{ text: 'Поправить', status: 'in_progress' }] },
    { kind: 'tool', id: 'b', text: 'Bash npm test', status: 'error', output: 'FAIL' },
    { kind: 'text', text: 'Тест падает' },
  ]);
  assert.equal(answer.text, 'Тест падает');
  assert.equal(answer.model, 'claude-x');
  assert.equal(answer.turns, 4);
  assert.equal(answer.durationMs, 3000);
  assert.equal(answer.usage?.costUsd, 0.01);

  stop = true;
  await core.sendChat(chat.id, 'Ещё раз');
  const stopped = (await untilIdle(core, chat.id)).messages.at(-1)!;
  assert.equal(stopped.stopped, true);
  const bash = stopped.parts?.find((p) => p.kind === 'tool' && p.id === 'b');
  assert.deepEqual(bash, { kind: 'tool', id: 'b', text: 'Bash npm test' }, 'без итога вызов не остаётся «выполняется»');
});

test('чат: @файл и /скилл уходят агенту блоком промпта; список файлов и скиллов проекта', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-chat-mention-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n');
  fs.writeFileSync(path.join(repo, 'secret.txt'), 'x\n');
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'review', 'SKILL.md'), '---\ndescription: Ревью\n---\n');
  git('add', 'src/a.ts');
  const calls: AgentRunOptions[] = [];
  const claude = async (o: AgentRunOptions) => {
    calls.push(o);
    return { ok: true, text: 'ок', usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  assert.deepEqual((await core.listChatFiles(repo)).sort(), ['.claude/skills/review/SKILL.md', '.gitignore', 'src/a.ts']);
  // Скилл не закоммичен — в отдельной рабочей копии прогона его не будет.
  assert.deepEqual(
    (await core.listChatSkills(repo)).map((s) => [s.name, s.untracked]),
    [['review', true]],
  );
  git('add', '.claude');
  assert.equal((await core.listChatSkills(repo))[0].untracked, undefined);
  const chat = await core.createChat({ agent: 'claude', projectPath: repo });
  await core.sendChat(chat.id, '/review посмотри @src/a.ts');
  await untilIdle(core, chat.id);
  assert.match(calls[0].prompt, /^\/review посмотри @src\/a\.ts/);
  assert.ok(calls[0].prompt.includes(`- ${path.join(repo, 'src', 'a.ts')}`));
  assert.ok(calls[0].prompt.includes(`- /review: ${path.join(repo, '.claude', 'skills', 'review', 'SKILL.md')}`));
});

test('чат: «Сжать контекст» — /compact в той же сессии claude, ответом уведомление, очередь уходит после', async () => {
  const calls: AgentRunOptions[] = [];
  let release: () => void = () => {};
  const claude = async (o: AgentRunOptions) => {
    calls.push(o);
    if (o.prompt === '/compact') {
      await new Promise<void>((r) => (release = r));
      o.onStep?.({ kind: 'notice', level: 'info', key: 'compact', text: 'Сжимаю контекст переписки…' });
      o.onStep?.({ kind: 'notice', level: 'info', key: 'compact', text: 'Контекст переписки сжат: 41 тыс. → 9 тыс. токенов' });
      o.onStep?.({ kind: 'meta', context: 8869 });
      return { ok: true, text: '', usage: emptyUsage() };
    }
    o.onStep?.({ kind: 'text', text: 'ок', delta: true });
    return { ok: true, text: 'ок', usage: emptyUsage() };
  };
  const core = makeCore({ claude });
  const chat = await core.createChat({ agent: 'claude' });
  // До первого сообщения сжимать нечего.
  await assert.rejects(core.compactChat(chat.id), /сессия начнётся/);
  await core.sendChat(chat.id, 'Привет');
  await untilIdle(core, chat.id);

  await core.compactChat(chat.id);
  assert.equal((await core.getChat(chat.id))!.busy, true);
  await assert.rejects(core.compactChat(chat.id), /Агент отвечает/);
  // Сообщение во время сжатия ждёт в очереди.
  await core.sendChat(chat.id, 'Дальше');
  release();
  const after = await untilIdle(core, chat.id);

  assert.equal(calls[1].prompt, '/compact');
  assert.equal(calls[1].resume, calls[0].sessionId, 'сжимается та же сессия');
  assert.equal(calls[1].systemPrompt, undefined);
  assert.equal(calls[2].prompt, 'Дальше');
  assert.equal(calls[2].resume, calls[0].sessionId);
  const roles = after.messages.map((m) => `${m.role}:${m.text}`);
  assert.deepEqual(roles, ['user:Привет', 'assistant:ок', 'assistant:', 'user:Дальше', 'assistant:ок']);
  const compacted = after.messages[2];
  assert.deepEqual(compacted.parts, [
    { kind: 'notice', level: 'info', key: 'compact', text: 'Контекст переписки сжат: 41 тыс. → 9 тыс. токенов' },
  ]);
  assert.equal(compacted.info?.context, 8869);

  // codex сжимает сам.
  await core.updateChat(chat.id, { agent: 'codex' });
  await assert.rejects(core.compactChat(chat.id), /codex сжимает/);
});

test('чат: уровень рассуждений уходит агенту и записывается в ответ; новый агент без такого уровня — как в CLI', async () => {
  const calls: AgentRunOptions[] = [];
  const reply = async (o: AgentRunOptions) => {
    calls.push(o);
    o.onStep?.({ kind: 'text', text: 'Ок', delta: true });
    return { ok: true, text: 'Ок', usage: emptyUsage() };
  };
  const core = makeCore({ claude: reply, codex: reply });
  const chat = await core.createChat({ agent: 'claude', effort: 'max' });
  assert.equal(chat.effort, 'max');
  await core.sendChat(chat.id, 'Вопрос');
  let after = await untilIdle(core, chat.id);
  assert.equal(calls[0].effort, 'max');
  assert.equal(after.messages.at(-1)!.effort, 'max');

  // max у codex нет — уровень сбрасывается, флаг не передаётся.
  assert.equal((await core.updateChat(chat.id, { agent: 'codex' })).effort, undefined);
  await core.sendChat(chat.id, 'Ещё');
  after = await untilIdle(core, chat.id);
  assert.equal(calls[1].effort, undefined);
  assert.equal(after.messages.at(-1)!.effort, undefined);

  assert.equal((await core.updateChat(chat.id, { effort: 'low' })).effort, 'low');
  assert.equal((await core.updateChat(chat.id, { effort: '' })).effort, undefined);
  // Неизвестный уровень не сохраняется.
  assert.equal((await core.updateChat(chat.id, { effort: 'ultra' })).effort, undefined);
});

test('чат: отказ codex в MCP — разрешение на ход или на весь чат, повторная просьба уходит сообщением', async () => {
  const calls: { mcpApprove?: { server: string; tool: string }[] }[] = [];
  let refuse = true;
  const codex = async (o: AgentRunOptions & { mcpApprove?: { server: string; tool: string }[] }) => {
    calls.push(o);
    o.onStep?.({ kind: 'tool', id: 'c1', text: 'cognify · cognify_status' });
    if (refuse) o.onStep?.({ kind: 'tool_result', id: 'c1', ok: false, approval: { server: 'cognify', tool: 'cognify_status' } });
    refuse = false;
    return { ok: true, text: 'Ок', usage: emptyUsage() };
  };
  const core = makeCore({ codex });
  const chat = await core.createChat({ agent: 'codex' });
  await core.sendChat(chat.id, 'Статус?');
  let after = await untilIdle(core, chat.id);
  const tool = after.messages.at(-1)!.parts!.find((p) => p.kind === 'tool');
  assert.deepEqual(tool && 'approval' in tool && tool.approval, { server: 'cognify', tool: 'cognify_status' });
  assert.deepEqual(calls[0].mcpApprove, []);

  // На один ход: разрешено в следующем, потом снова нет.
  await core.allowChatMcp(chat.id, { server: 'cognify', tool: 'cognify_status' });
  after = await untilIdle(core, chat.id);
  assert.match(after.messages.at(-2)!.text, /Разрешаю вызов cognify · cognify_status/);
  assert.deepEqual(calls[1].mcpApprove, [{ server: 'cognify', tool: 'cognify_status' }]);
  await core.sendChat(chat.id, 'Ещё');
  await untilIdle(core, chat.id);
  assert.deepEqual(calls[2].mcpApprove, []);

  // На весь чат.
  await core.allowChatMcp(chat.id, { server: 'cognify', tool: 'cognify_status', always: true });
  await untilIdle(core, chat.id);
  await core.sendChat(chat.id, 'И ещё');
  after = await untilIdle(core, chat.id);
  assert.deepEqual(calls[4].mcpApprove, [{ server: 'cognify', tool: 'cognify_status' }]);
  assert.deepEqual(after.mcpAllow, [{ server: 'cognify', tool: 'cognify_status' }]);
});

test('readChatFile: только внутри проекта, двоичный — без содержимого, большой — обрезан', async () => {
  const { readChatFile } = await import('./services/chat.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-read-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(proj, 'img.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(proj, 'big.txt'), 'x'.repeat(600 * 1024));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'нельзя');
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(proj, 'link.txt'));
  try {
    assert.equal(readChatFile(proj, 'src/a.ts').text, 'export const a = 1;\n');
    assert.deepEqual(readChatFile(proj, 'img.bin'), { text: '', truncated: false, binary: true, size: 3 });
    const big = readChatFile(proj, 'big.txt');
    assert.equal(big.truncated, true);
    assert.equal(big.text.length, 512 * 1024);
    assert.throws(() => readChatFile(proj, '../secret.txt'), /вне папки/);
    assert.throws(() => readChatFile(proj, 'link.txt'), /вне папки/);
    assert.throws(() => readChatFile(proj, 'src'), /не файл/);
    fs.writeFileSync(path.join(proj, 'pic.png'), Buffer.from([137, 80, 78, 71]));
    const pic = readChatFile(proj, 'pic.png');
    assert.equal(pic.media?.mime, 'image/png');
    assert.deepEqual([...pic.media!.data!], [137, 80, 78, 71]);
    fs.writeFileSync(path.join(proj, 'huge.png'), Buffer.alloc(26 * 1024 * 1024));
    assert.deepEqual(readChatFile(proj, 'huge.png').media, { mime: 'image/png', tooBig: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Git (просмотр): ветки с отставанием от main, история с родителями и ссылками, дифф коммита и первого коммита', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gitview-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'один\n');
  git('add', '.');
  git('commit', '-qm', 'первый');
  git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'фича\n');
  git('add', '.');
  git('commit', '-qm', 'фича');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'два\n');
  git('commit', '-qam', 'правка main');
  git('tag', '-a', 'v1', '-m', 'v1');
  git('merge', '-q', '--no-ff', 'feature', '-m', 'слияние');
  git('checkout', '-qb', 'later');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'потом\n');
  git('add', '.');
  git('commit', '-qm', 'позже');
  git('checkout', '-q', 'main');
  const core = makeCore({});
  try {
    const g = await core.getGitGraph(repo);
    assert.equal(g.current, 'main');
    assert.equal(g.base, 'main');
    // Дети выше родителей; порядок параллельных веток — любой из допустимых.
    const by = (s: string) => g.commits.find((c) => c.subject === s)!;
    assert.deepEqual([g.commits[0].subject, g.commits[1].subject, g.commits[4].subject], ['позже', 'слияние', 'первый']);
    const merge = by('слияние');
    assert.equal(merge.parents.length, 2);
    assert.deepEqual(merge.refs, ['main']);
    assert.deepEqual(by('правка main').refs, ['tag: v1']);
    const later = g.branches.find((b) => b.name === 'later')!;
    assert.deepEqual([later.ahead, later.behind], [1, 0]);
    assert.equal(g.branches.find((b) => b.name === 'main')!.ahead, undefined);
    assert.equal(g.more, false);
    assert.equal((await core.getGitGraph(repo, 2)).more, true);

    const d = await core.getGitCommitDiff(repo, by('правка main').hash);
    assert.deepEqual(
      d.map((f) => [f.path, f.status, f.original, f.modified]),
      [['a.txt', 'M', 'один\n', 'два\n']],
    );
    const first = await core.getGitCommitDiff(repo, by('первый').hash);
    assert.deepEqual(
      first.map((f) => [f.path, f.status]),
      [['a.txt', 'A']],
    );
    await assert.rejects(core.getGitCommitDiff(repo, 'HEAD; rm -rf'), /Неверный коммит/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('чат на agy в «Правках»: запрос разрешения ждёт человека, «в этом чате» запоминается на следующие ходы', async () => {
  const calls: AgyOptions[] = [];
  const answers: string[] = [];
  const agy = async (o: AgyOptions) => {
    calls.push(o);
    if (calls.length === 1) {
      const a = await o.askPermission!({
        id: 'p1',
        text: 'Bash git push',
        detail: 'git push',
        reason: 'git-операции доступны только с полным доступом',
      });
      answers.push(a);
      if (a === 'always') o.onAllow?.('command:git push');
    }
    o.onStep?.({ kind: 'text', text: 'Готово' });
    return { ok: true, text: 'Готово', usage: emptyUsage() };
  };
  const core = makeCore({ agy });
  const chat = await core.createChat({ agent: 'agy' });
  await core.updateChat(chat.id, { edits: true });
  await core.sendChat(chat.id, 'Отправь ветку');
  // Карточка появляется, пока ход идёт.
  let part;
  for (let i = 0; i < 200 && !part; i++) {
    part = (await core.getChat(chat.id))!.chat.messages.at(-1)!.parts?.find((p) => p.kind === 'permission');
    if (!part) await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(part, {
    kind: 'permission',
    id: 'p1',
    text: 'Bash git push',
    detail: 'git push',
    reason: 'git-операции доступны только с полным доступом',
    state: 'pending',
  });
  await core.answerChatPermission(chat.id, 'p1', 'always');
  const done = await untilIdle(core, chat.id);
  assert.deepEqual(answers, ['always']);
  assert.equal((done.messages.at(-1)!.parts!.find((p) => p.kind === 'permission') as { state: string }).state, 'always');
  assert.deepEqual(done.agyAllow, ['command:git push']);
  await assert.rejects(core.answerChatPermission(chat.id, 'p1', 'once'), /не ждёт ответа/);

  await core.sendChat(chat.id, 'Ещё раз');
  await untilIdle(core, chat.id);
  assert.deepEqual(calls[1].allowed, ['command:git push']);
  assert.equal(calls[1].limited, true);
});

test('чат на agy: в «Вопросах» и с полным доступом человека не спрашивают; карточка без ответа гаснет с ходом', async () => {
  const calls: AgyOptions[] = [];
  const agy = async (o: AgyOptions) => {
    calls.push(o);
    // Ход кончился, не дождавшись ответа (стоп или сбой agy).
    if (o.askPermission)
      void o.askPermission({ id: 'p1', text: 'Bash rm -rf /tmp/x', reason: 'запись вне папки проекта доступна только с полным доступом' });
    return { ok: true, text: 'Ок', usage: emptyUsage() };
  };
  const core = makeCore({ agy });
  const chat = await core.createChat({ agent: 'agy', edits: false });
  await core.sendChat(chat.id, 'Вопрос');
  await untilIdle(core, chat.id);
  assert.equal(calls[0].askPermission, undefined);
  assert.equal(calls[0].readOnly, true);
  await core.updateChat(chat.id, { edits: true });
  await core.sendChat(chat.id, 'Правка');
  const after = await untilIdle(core, chat.id);
  assert.equal((after.messages.at(-1)!.parts!.find((p) => p.kind === 'permission') as { state: string }).state, 'expired');
  await core.updateChat(chat.id, { fullAccess: true });
  await core.sendChat(chat.id, 'Полный');
  await untilIdle(core, chat.id);
  assert.equal(calls.at(-1)!.askPermission, undefined);
});

test('чат: папки в контексте — агенту доступ (--add-dir) и пути в промпте; папка проекта и повторы отбрасываются', async () => {
  const calls: AgentRunOptions[] = [];
  const core = makeCore({
    claude: async (o: AgentRunOptions) => {
      calls.push(o);
      return { ok: true, text: 'Ок', usage: emptyUsage() };
    },
  });
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-proj-')));
  const docs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-docs-')));
  const chat = await core.createChat({ agent: 'claude', projectPath: project, dirs: [docs, docs, project] });
  assert.deepEqual(chat.dirs, [docs]);
  await core.sendChat(chat.id, 'Сравни с документацией');
  await untilIdle(core, chat.id);
  assert.deepEqual(calls[0].addDirs, [docs]);
  assert.match(calls[0].prompt, new RegExp(`Папки, добавленные в контекст чата[\\s\\S]*- ${docs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(claudeArgs(calls[0] as never).join(' '), new RegExp(`--add-dir ${docs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // Ошибочный путь — понятная ошибка, а не тихо пропущенная папка.
  const file = path.join(docs, 'a.txt');
  fs.writeFileSync(file, 'x');
  await assert.rejects(core.updateChat(chat.id, { dirs: [docs, file] }), /Это не папка/);
  await assert.rejects(core.updateChat(chat.id, { dirs: ['relative/dir'] }), /полный путь/);
  // Убрали все — поля нет, следующему ходу папок не передаём.
  assert.equal((await core.updateChat(chat.id, { dirs: [] })).dirs, undefined);
  await core.sendChat(chat.id, 'Ещё');
  await untilIdle(core, chat.id);
  assert.deepEqual(calls[1].addDirs, []);
  assert.doesNotMatch(calls[1].prompt, /Папки, добавленные в контекст/);
});

test('чат: после первого ответа модель даёт название; переименованный человеком чат не трогает', async () => {
  const prompts: string[] = [];
  const claude = async (o: AgentRunOptions) => {
    prompts.push(o.prompt);
    if (/Придумай короткое название/.test(o.prompt)) return { ok: true, text: '«Устройство проекта».', usage: emptyUsage() };
    o.onStep?.({ kind: 'text', text: 'Это монорепозиторий', delta: true });
    return { ok: true, text: 'Это монорепозиторий', usage: emptyUsage() };
  };
  const core = makeCore({ claude }, { chatTitles: true });
  const events: CoreEvent[] = [];
  core.on((e) => events.push(e));
  const chat = await core.createChat({ agent: 'claude' });
  await core.sendChat(chat.id, 'слушай, а как вообще устроен этот проект и где что лежит?');
  await untilIdle(core, chat.id);
  for (let i = 0; i < 100 && (await core.getChat(chat.id))!.chat.title !== 'Устройство проекта'; i++)
    await new Promise((r) => setTimeout(r, 20));
  const named = (await core.getChat(chat.id))!.chat;
  assert.equal(named.title, 'Устройство проекта');
  assert.equal(named.autoTitle, undefined);
  // Пока модель думала, окно получало чат с titling — для заглушки; после — флага нет.
  assert.ok(events.some((e) => e.type === 'chat.updated' && e.chat.titling === true));
  assert.equal(named.titling, undefined);
  assert.equal((await core.listChats()).find((c) => c.id === chat.id)?.titling, undefined);
  // В запросе названия — начало переписки.
  const ask = prompts.find((p) => /Придумай короткое название/.test(p))!;
  assert.match(ask, /Человек: слушай, а как вообще устроен/);
  assert.match(ask, /Ассистент: Это монорепозиторий/);
  // Второй ход названия не спрашивает.
  await core.sendChat(chat.id, 'А тесты где?');
  await untilIdle(core, chat.id);
  assert.equal(prompts.filter((p) => /Придумай короткое название/.test(p)).length, 1);

  // Заглушка — сразу после отправки первого сообщения, ещё до ответа.
  const firstSave = events.find((e) => e.type === 'chat.updated' && e.chat.id === chat.id && e.chat.messages.length === 1);
  assert.equal(firstSave?.type === 'chat.updated' && firstSave.chat.titling, true);

  // Первый ответ не удался — заглушка уходит, название остаётся из сообщения.
  const failing = makeCore({ claude: async () => ({ ok: false, text: '', usage: emptyUsage(), error: 'нет сети' }) }, { chatTitles: true });
  const broken = await failing.createChat({ agent: 'claude' });
  await failing.sendChat(broken.id, 'упадёт');
  const after = await untilIdle(failing, broken.id);
  assert.equal(after.titling, undefined);
  assert.equal(after.title, 'упадёт');

  // Человек переименовал до ответа — название модели не применяется.
  const other = await core.createChat({ agent: 'claude' });
  await core.sendChat(other.id, 'вопрос');
  await core.updateChat(other.id, { title: 'Моё название' });
  await untilIdle(core, other.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await core.getChat(other.id))!.chat.title, 'Моё название');
});

test('cleanTitle: первая строка без кавычек, разметки и точки', () => {
  assert.equal(cleanTitle('«Настройка CI».\nещё строка'), 'Настройка CI');
  assert.equal(cleanTitle('## Название: **Ревью PR**'), 'Ревью PR');
  assert.equal(cleanTitle('   '), '');
});

test(
  'чат: браузер для агента — правила pw в системном промпте, пометка в сообщении, в «Вопросах» нет',
  { skip: process.platform === 'win32' },
  async (t) => {
    const calls: AgentRunOptions[] = [];
    const claude = async (o: AgentRunOptions) => {
      calls.push(o);
      return { ok: true, text: 'ок', usage: emptyUsage() };
    };
    // Браузер чата даёт мост к окну приложения; адрес не важен — сообщения не про веб, pw не подключается.
    setChatWebBridge({ port: 9, key: '00'.repeat(32) });
    t.after(() => setChatWebBridge(null));
    const core = makeCore({ claude }, { browser: true });
    // Сообщение не про веб — pw к окну не подключается, но правила и пометка есть.
    for (const fullAccess of [true, false]) {
      const c = await core.createChat({ agent: 'claude', fullAccess });
      await core.sendChat(c.id, 'поправь опечатку в README');
      await untilIdle(core, c.id);
      const call = calls.at(-1)!;
      assert.match(call.systemPrompt ?? '', /## Браузер/);
      assert.match(call.systemPrompt ?? '', /не вызывай `pw open`/);
      assert.match(call.prompt, /\[PurpleFlow: браузер сейчас не запущен/);
      const pwDir = (call.env?.PATH ?? '').split(path.delimiter)[0];
      assert.match(pwDir, /browser$/);
      assert.ok(call.addDirs?.includes(pwDir), 'папка скриншотов открыта агенту на чтение');
    }
    // «Вопросы»: команд нет — и браузера нет.
    const read = await core.createChat({ agent: 'claude', edits: false });
    await core.sendChat(read.id, 'открой гугл');
    await untilIdle(core, read.id);
    assert.doesNotMatch(calls.at(-1)!.systemPrompt ?? '', /## Браузер/);
  },
);

test('чат: картинки — MCP PurpleSchool у claude и правило в промпте; без них просьба нарисовать даёт карточку входа', async () => {
  const calls: AgentRunOptions[] = [];
  const claude = async (o: AgentRunOptions) => {
    calls.push(o);
    return { ok: true, text: 'ок', usage: emptyUsage() };
  };
  const media = { url: 'https://app.purpleschool.ru/api-v2/mcp', key: 'ppk_x' };
  const on = makeCore({ claude }, { settings: { media } });
  const c = await on.createChat({ agent: 'claude' });
  await on.sendChat(c.id, 'нарисуй иконку оплаты');
  await untilIdle(on, c.id);
  assert.deepEqual(calls.at(-1)!.media, media);
  assert.match(calls.at(-1)!.systemPrompt ?? '', /## Картинки/);

  // Не вошёл в PurpleSchool: сервера нет, под ответом на просьбу нарисовать — карточка входа; на другое — нет.
  const off = makeCore({ claude }, { settings: { mediaOffer: 'signup' } });
  const d = await off.createChat({ agent: 'claude' });
  await off.sendChat(d.id, 'Нарисуй кота для обложки');
  await untilIdle(off, d.id);
  assert.equal(calls.at(-1)!.media, undefined);
  const offers = async () => ((await off.getChat(d.id))!.chat.messages.at(-1)!.parts ?? []).filter((p) => p.kind === 'offer');
  assert.deepEqual(await offers(), [{ kind: 'offer', offer: 'signup' }]);
  await off.sendChat(d.id, 'поправь опечатку в README');
  await untilIdle(off, d.id);
  assert.deepEqual(await offers(), []);
});

test('wantsImage: просьбы нарисовать — да, обычные задачи — нет', () => {
  for (const t of ['нарисуй иконку', 'Сгенерируй картинку для лендинга', 'сделай мне логотип', 'draw a cat', 'generate an image of a dog'])
    assert.ok(wantsImage(t), t);
  for (const t of ['поправь README', 'сделай рефакторинг', 'создай компонент кнопки', 'нарушение в логике']) assert.ok(!wantsImage(t), t);
});
