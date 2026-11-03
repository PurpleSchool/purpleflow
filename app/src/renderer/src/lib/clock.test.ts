import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunFile, StageAttempt } from '@purpleflow/core';
import { isGate, rowOf, stageBars } from './bars';
import { activeClock, agentTime, ms } from './clock';

const T0 = Date.parse('2026-10-30T10:00:00Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** Попытка от from до to секунд от начала; без to — ещё идёт. */
const at = (stage: StageAttempt['stage'], from: number, to?: number, p: Partial<StageAttempt> = {}): StageAttempt => ({
  stage,
  attempt: 1,
  startedAt: iso(from),
  endedAt: to === undefined ? undefined : iso(to),
  status: to === undefined ? 'running' : 'done',
  ...p,
});

const run = (attempts: StageAttempt[]) =>
  ({ mode: 'task', visual: false, status: 'running', next: 'plan', attempts }) as unknown as RunFile;

test('activeClock: короткие переходы считаются, длинная пауза вырезается', () => {
  const c = activeClock(run([at('plan', 0, 10), at('implement', 12, 20), at('tests', 620, 630)]), T0 + 631_000);
  assert.equal(c.total, 30_000); // 0–20 и 620–630
  assert.equal(c.paused, 600_000);
  assert.deepEqual(c.gaps, [{ at: 20_000, ms: 600_000 }]);
  assert.equal(c.map(T0 + 5_000), 5_000);
  assert.equal(c.map(T0 + 300_000), 20_000); // Посреди паузы — на её месте.
  assert.equal(c.map(T0 + 625_000), 25_000);
  assert.equal(c.map(T0 + 999_000), 30_000);
});

test('activeClock: идущая попытка тянется до «сейчас», оборванная — нулевая', () => {
  assert.equal(activeClock(run([at('implement', 0)]), T0 + 7_000).total, 7_000);
  const aborted = at('implement', 0, undefined, { status: 'stopped' });
  assert.equal(activeClock(run([aborted]), T0 + 7_000).total, 0);
});

test('activeClock: параллельные попытки не считаются дважды', () => {
  assert.equal(activeClock(run([at('tests', 0, 10), at('review', 2, 8)]), T0 + 11_000).total, 10_000);
});

test('activeClock: compressGates сжимает ожидание человека, работа агентов не страдает', () => {
  const r = run([at('plan', 0, 100), at('gate1', 100, 3700), at('implement', 3700, 3800)]);
  const now = T0 + 3800_000;
  const plain = activeClock(r, now);
  const c = activeClock(r, now, { compressGates: true });
  assert.equal(plain.total, 3800_000);
  assert.ok(c.total < 300_000, 'час ожидания сжат до небольшого слота');
  assert.equal(c.map(T0 + 50_000), 50_000); // До гейта шкала не меняется.
  // Плановая стадия и реализация занимают одинаковую долю шкалы, сколько бы ни ждал человек.
  const planLen = c.map(T0 + 100_000) - c.map(T0);
  const implLen = c.map(T0 + 3800_000) - c.map(T0 + 3700_000);
  assert.ok(Math.abs(planLen - implLen) < 1);
});

test('agentTime: без гейтов, параллельные — один раз', () => {
  const r = run([at('plan', 0, 10), at('gate1', 10, 1000), at('tests', 1000, 1010), at('review', 1005, 1020)]);
  assert.equal(agentTime(r, T0 + 2000_000), 30_000);
  assert.equal(agentTime(run([]), T0), 0);
  assert.equal(agentTime(run([at('implement', 0)]), T0 + 3_000), 3_000);
});

test('ms: секунды, минуты, часы, отрицательное — ноль', () => {
  assert.equal(ms(-5), '0 с');
  assert.equal(ms(59_400), '59 с');
  assert.equal(ms(257_000), '4 мин 17 с');
  assert.equal(ms(3_660_000), '1 ч 1 мин');
});

test('rowOf: ответы на вопросы — в уточнении, лимит — в строке упавшей стадии', () => {
  const failed = at('tests', 0, 5, { status: 'failed' });
  const limit = at('limit', 5, 6);
  const r = run([at('implement', 0, 0), failed, limit]);
  assert.equal(rowOf(r, limit), 'tests');
  assert.equal(rowOf(r, at('gate0', 0, 1)), 'clarify');
  assert.equal(rowOf(r, failed), 'tests');
  assert.ok(isGate('gate2'));
  assert.ok(!isGate('tests'));
});

test('stageBars: положение на шкале, вид полоски и подсказка', () => {
  const r = run([
    at('implement', 0, 50, { model: 'opus', summary: 'готово' }),
    at('implement', 50, 75, { attempt: 2, status: 'failed' }),
    at('implement', 75, undefined, { attempt: 3 }),
    at('gate2', 75, 80),
  ]);
  const now = T0 + 100_000;
  const bars = stageBars(r, activeClock(r, now), 'implement', now);
  assert.deepEqual(
    bars.map((b) => b.kind),
    ['done', 'fail', 'live'],
  );
  assert.equal(bars[0].left, 0);
  assert.equal(bars[0].width, 50);
  assert.equal(bars[1].left, 50);
  assert.equal(bars[1].width, 25);
  assert.match(bars[0].tip, /попытка 1/);
  assert.match(bars[0].tip, /opus/);
  assert.match(bars[0].tip, /\nготово$/);
  assert.equal(stageBars(r, activeClock(r, now), 'gate2', now)[0].kind, 'wait');
});

test('stageBars: совсем короткая попытка всё равно видна, одна попытка — без номера в подсказке', () => {
  const r = run([at('plan', 0, 1000), at('tests', 1000, 1000)]);
  const now = T0 + 1000_000;
  const [bar] = stageBars(r, activeClock(r, now), 'tests', now);
  assert.equal(bar.width, 0.8);
  assert.doesNotMatch(bar.tip, /попытка/);
});
