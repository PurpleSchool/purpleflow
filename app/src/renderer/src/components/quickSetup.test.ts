import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPreset } from './QuickSetup';

const row = (m: ReturnType<typeof buildPreset>['models']) => [m.planner, m.reviewer, m.executor, m.manager, m.visual, m.scan];

test('buildPreset: роли растут на ступень от пресета к пресету, сильнее всех — планировщик и ревьюер', () => {
  // планировщик, ревьюер, исполнитель, менеджер, визуальная проверка, сканирование
  assert.deepEqual(row(buildPreset('claude', 'economy').models), ['sonnet', 'sonnet', 'haiku', 'haiku', 'haiku', 'haiku']);
  assert.deepEqual(row(buildPreset('claude', 'optimal').models), ['opus', 'opus', 'sonnet', 'sonnet', 'haiku', 'haiku']);
  assert.deepEqual(row(buildPreset('claude', 'max').models), ['claude-fable-5-2', 'claude-fable-5-2', 'opus', 'opus', 'sonnet', 'sonnet']);
  // У codex ступень в ступень: haiku → luna, sonnet → terra, opus → sol, Fable → astra.
  assert.deepEqual(row(buildPreset('codex', 'economy').models), [
    'gpt-6.1-terra',
    'gpt-6.1-terra',
    'gpt-6-luna',
    'gpt-6-luna',
    'gpt-6-luna',
    'gpt-6-luna',
  ]);
  assert.deepEqual(row(buildPreset('codex', 'optimal').models), [
    'gpt-6-sol',
    'gpt-6-sol',
    'gpt-6.1-terra',
    'gpt-6.1-terra',
    'gpt-6-luna',
    'gpt-6-luna',
  ]);
  assert.deepEqual(row(buildPreset('codex', 'max').models), [
    'gpt-6-astra',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-sol',
    'gpt-6.1-terra',
    'gpt-6.1-terra',
  ]);
});

test('buildPreset: ревьюер нигде не на модели исполнителя, все роли — на основном агенте', () => {
  for (const a of ['claude', 'codex'] as const)
    for (const p of ['economy', 'optimal', 'max'] as const) {
      const { agents, models } = buildPreset(a, p);
      assert.notEqual(models.reviewer, models.executor, `${a} ${p}`);
      assert.ok(Object.values(agents).every((x) => x === a));
    }
});
