import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatFile, ChatSummary, RunFile, RunSummary } from '@purpleflow/core';
import { chatSummary, reducer, summarize, type State } from './reducer';

const state = (p: Partial<State> = {}): State => ({
  view: { name: 'new' },
  settings: null,
  tools: null,
  toolsLoading: false,
  runs: [],
  runsLoaded: false,
  details: {},
  chats: [],
  ...p,
});
const run = (id: string, p: Partial<RunFile> = {}) => ({ id, title: id, status: 'running', next: 'plan', ...p }) as RunFile;
const chat = (id: string, updatedAt: string) => ({ id, updatedAt }) as ChatSummary;

test('reducer: обновление прогона добавляет строку и сохраняет известный путь run.json', () => {
  let s = reducer(state(), { t: 'run', run: run('a') });
  assert.deepEqual(
    s.runs.map((r) => r.id),
    ['a'],
  );
  assert.equal(s.details.a.id, 'a');
  s = { ...s, runs: [{ ...s.runs[0], runJsonPath: '/p/run.json' }] };
  s = reducer(s, { t: 'run', run: run('a', { status: 'waiting' }) });
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].status, 'waiting');
  assert.equal(s.runs[0].runJsonPath, '/p/run.json');
});

test('reducer: удаление открытого прогона уводит с его экрана, чужого — нет', () => {
  const base = reducer(state({ view: { name: 'run', runId: 'a' } }), { t: 'run', run: run('a') });
  const opened = reducer(base, { t: 'deleted', runId: 'a' });
  assert.deepEqual(opened.view, { name: 'new' });
  assert.deepEqual(opened.runs, []);
  assert.equal(opened.details.a, undefined);
  assert.deepEqual(reducer(base, { t: 'deleted', runId: 'b' }).view, { name: 'run', runId: 'a' });
});

test('reducer: чаты — свежие сверху, удаление открытого ведёт к новому чату', () => {
  let s = reducer(state({ chats: [chat('old', '2026-01-01'), chat('mid', '2026-01-02')] }), { t: 'chat', chat: chat('old', '2026-01-03') });
  assert.deepEqual(
    s.chats.map((c) => c.id),
    ['old', 'mid'],
  );
  s = { ...s, view: { name: 'chat', chatId: 'old' } };
  s = reducer(s, { t: 'chatDeleted', chatId: 'old' });
  assert.deepEqual(s.view, { name: 'chat' });
  assert.deepEqual(
    s.chats.map((c) => c.id),
    ['mid'],
  );
});

test('reducer: инструменты при новой проверке не пропадают, список прогонов отмечается полученным', () => {
  const tools = {} as NonNullable<State['tools']>;
  assert.equal(reducer(state({ tools }), { t: 'tools', tools: null, loading: true }).tools, tools);
  assert.equal(reducer(state(), { t: 'runs', runs: [] as RunSummary[] }).runsLoaded, true);
});

test('summarize и chatSummary: last — итог последнего завершённого ответа', () => {
  assert.equal(summarize(run('a')).runJsonPath, '');
  const c = (messages: object[]) => ({ id: 'c', messages }) as unknown as ChatFile;
  assert.equal(chatSummary(c([]), false).last, null);
  assert.equal(chatSummary(c([{ role: 'assistant' }]), false).last, 'ok');
  assert.equal(
    chatSummary(
      c([
        { role: 'assistant', error: 'x' },
        { role: 'assistant', pending: true },
      ]),
      true,
    ).last,
    'error',
  );
  assert.equal(chatSummary(c([{ role: 'assistant', stopped: true }, { role: 'user' }]), false).last, 'error');
});
