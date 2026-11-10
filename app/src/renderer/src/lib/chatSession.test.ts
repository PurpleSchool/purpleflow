import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@purpleflow/core';
import { chatSession, mcpStatus } from './chatSession';

const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: Math.random().toString(), role: 'assistant', at: '', text: '', ...m });

test('chatSession: пустой чат', () => {
  const s = chatSession({ messages: [] });
  assert.equal(s.answers, 0);
  assert.equal(s.context, undefined);
  assert.equal(s.compacted, false);
});

test('chatSession: контекст — из последнего ответа, окно — последнее известное', () => {
  const s = chatSession({
    messages: [
      msg({ role: 'user', text: 'привет' }),
      msg({
        model: 'claude-x',
        turns: 2,
        durationMs: 1000,
        usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 0.1 },
        info: { context: 1000, contextWindow: 200_000, cwd: '/w', version: '2.1', mcp: [{ name: 'gh', status: 'connected' }] },
        parts: [{ kind: 'notice', level: 'info', key: 'compact', text: 'сжат' }],
      }),
      msg({ role: 'user', text: 'ещё' }),
      // Остановленный ход: контекст пришёл, итога с окном и стоимостью — нет.
      msg({
        turns: 1,
        durationMs: 500,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        info: { context: 50_000 },
        stopped: true,
      }),
      msg({ pending: true, info: { context: 999_999 } }),
    ],
  });
  assert.equal(s.answers, 2);
  assert.deepEqual(s.context, { used: 50_000, window: 200_000, pct: 25 });
  assert.equal(s.model, 'claude-x');
  assert.equal(s.cwd, '/w');
  assert.equal(s.version, '2.1');
  assert.deepEqual(s.mcp, [{ name: 'gh', status: 'connected' }]);
  assert.equal(s.compacted, true);
});

test('chatSession: без окна процента нет; последний ответ без контекста — контекст неизвестен', () => {
  assert.deepEqual(chatSession({ messages: [msg({ info: { context: 10 } })] }).context, { used: 10, window: undefined, pct: undefined });
  assert.equal(chatSession({ messages: [msg({ info: { context: 10 } }), msg({ text: 'codex' })] }).context, undefined);
});

test('mcpStatus: состояния по-русски', () => {
  assert.deepEqual(mcpStatus('connected'), { label: 'подключён', tone: 'ok' });
  assert.deepEqual(mcpStatus('failed').tone, 'error');
  assert.deepEqual(mcpStatus('needs-auth').tone, 'warn');
  assert.deepEqual(mcpStatus('weird'), { label: 'weird', tone: 'idle' });
});
