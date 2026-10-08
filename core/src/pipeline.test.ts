import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orchestrator, type CoreSettings } from './orchestrator.js';
import { acceptTarget, afterChecks, limitRow, plannedRoute, reviewInParallel, skippedStages } from './route.js';
import { loadLoginShellEnv } from './env.js';
import type { AgentResult } from './agents/common.js';
import type { RunFile, StageAttempt } from './types.js';

const at = (stage: StageAttempt['stage'], status: StageAttempt['status'] = 'done'): StageAttempt => ({ stage, attempt: 1, startedAt: '2026-01-01T00:00:00Z', status });
const runOf = (p: Partial<RunFile>) => ({ mode: 'task', visual: false, attempts: [], status: 'running', next: 'tests', ...p }) as RunFile;

test('route: куда после проверок и что пропускается в каждом круге', () => {
  assert.equal(afterChecks(runOf({})), 'review');
  assert.equal(afterChecks(runOf({ quickFix: true })), 'gate2');
  assert.equal(afterChecks(runOf({ roundFiles: ['a.ts'] })), 'gate2');
  assert.equal(afterChecks(runOf({ mergeOnly: true })), 'finish');
  assert.equal(afterChecks(runOf({ visual: true }), false), 'visual');
  assert.deepEqual([...skippedStages(runOf({ quickFix: true, visual: true }))].sort(), ['review', 'visual']);
  assert.ok(reviewInParallel(runOf({})));
  assert.ok(!reviewInParallel(runOf({ quickFix: true })));
  assert.ok(!reviewInParallel(runOf({ mode: 'epic', phase: 1, phases: 3 })));
});

test('route: «попытки исчерпаны» — в строке упавшей стадии; «дальше как есть» — в визуальную, если она не отказала', () => {
  const r = runOf({ visual: true, attempts: [at('implement'), at('tests', 'failed'), at('review', 'done'), at('limit', 'running')] });
  assert.equal(limitRow(r), 'tests');
  assert.equal(limitRow(runOf({ attempts: [at('implement'), at('tests', 'failed'), at('review', 'failed')] })), 'review');
  assert.equal(acceptTarget(r), 'visual');
  assert.equal(acceptTarget(runOf({ visual: true, attempts: [at('visual', 'failed')] })), 'gate2');
  const plan = plannedRoute(runOf({ next: 'implement', quickFix: true, visual: true, attempts: [at('implement', 'running')] }));
  assert.equal(plan.tests, 'planned');
  assert.equal(plan.review, 'skip');
  assert.equal(plan.visual, 'skip');
  assert.equal(plan.gate2, 'planned');
});

// ——— Конвейер целиком: настоящие git, openspec и тесты, фейковые агенты ———

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const env = loadLoginShellEnv();
const hasOpenspec = (() => { try { execFileSync('openspec', ['--version'], { env, stdio: 'ignore' }); return true; } catch { return false; } })();

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psflow-pipe-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "p", "type": "module" }\n');
  fs.writeFileSync(path.join(dir, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(dir, 'test/math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

const ok = (text: string): AgentResult => ({ ok: true, text, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

/** Фейковый claude: отвечает по роли (видно по промпту) и пишет файлы, как настоящий агент. */
function fakeClaude(script: { implement: (n: number, cwd: string, prompt: string) => void; review: (n: number) => object }) {
  let impl = 0;
  let rev = 0;
  const prompts: string[] = [];
  const fn = async (o: { prompt: string; cwd: string; systemPrompt?: string }): Promise<AgentResult> => {
    const p = o.prompt;
    const sys = o.systemPrompt ?? '';
    if (/Перед планом проверь/.test(p)) return ok('{"questions": []}');
    if (/второй, независимый ревьюер/.test(p)) return ok('{"items":[{"index":1,"verdict":"confirmed","reason":"сценарий есть"}]}');
    if (/ревьюер в конвейере PurpleFlow/.test(p)) { rev++; return ok(JSON.stringify(script.review(rev))); }
    if (/планировщик/.test(sys)) {
      const id = p.match(/используй ровно его\): `([^`]+)`/)![1];
      const d = path.join(o.cwd, 'openspec', 'changes', id);
      fs.mkdirSync(path.join(d, 'specs', 'calc'), { recursive: true });
      fs.writeFileSync(path.join(d, 'proposal.md'), '# Умножение\n\n## Why\nНужно умножать два числа, сейчас есть только сложение, и это неудобно.\n\n## What Changes\n- mul\n\n## Impact\n- `src/math.js`\n\n## Invariants\n- add работает\n');
      fs.writeFileSync(path.join(d, 'tasks.md'), '## 1. Код\n- [ ] 1.1 mul в src/math.js\n- [ ] 1.2 тест\n');
      fs.writeFileSync(path.join(d, 'specs', 'calc', 'spec.md'), '## ADDED Requirements\n### Requirement: Умножение\nКалькулятор SHALL умножать.\n\n#### Scenario: Два числа\n- **WHEN** mul(2, 3)\n- **THEN** 6\n');
      return ok('План готов.');
    }
    if (/исполнитель/.test(sys) || /Реализуй изменение|Продолжаем то же изменение/.test(p)) {
      impl++;
      prompts.push(p);
      script.implement(impl, o.cwd, p);
      return ok(`Попытка ${impl} сделана.`);
    }
    // Служебное: профиль, сводка, уроки, карта плана.
    return ok('{}');
  };
  return { fn, prompts: () => prompts, reviews: () => rev };
}

async function untilGate(core: Orchestrator, runId: string, gate: string, timeoutMs = 60_000): Promise<RunFile> {
  const t0 = Date.now();
  for (;;) {
    const r = core.getRun(runId)!;
    if (r.status === 'waiting' && r.next === gate) return r;
    if (r.status === 'stopped' || r.status === 'finished' || r.status === 'cancelled') throw new Error(`прогон остановился: ${r.message ?? r.status} (next=${r.next})`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались ${gate}, сейчас ${r.next}/${r.status}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

function makeCore(fake: ReturnType<typeof fakeClaude>) {
  const settings = { toolPaths: {}, proxy: { baseUrl: '', apiKey: '' }, models: { planner: '', executor: '', reviewer: '' }, agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' }, agentTimeoutMin: 5, testTimeoutMin: 2, maxParallel: 2 } as unknown as CoreSettings;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psflow-data-'));
  return new Orchestrator({ dataDir, promptsDir: PROMPTS, env, getSettings: () => settings, runners: { claude: fake.fn as never } });
}

test('конвейер: красные тесты и блокирующее ревью — один возврат, затем зелёное и приёмка', { skip: !hasOpenspec, timeout: 120_000 }, async () => {
  const repo = makeRepo();
  const fake = fakeClaude({
    implement: (n, cwd) => {
      // Первая попытка: mul с ошибкой и тест, который её ловит; вторая — исправление.
      fs.writeFileSync(path.join(cwd, 'src/math.js'), `export const add = (a, b) => a + b;\nexport const mul = (a, b) => ${n === 1 ? 'a + b' : 'a * b'};\n`);
      fs.writeFileSync(path.join(cwd, 'test/mul.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mul } from '../src/math.js';\ntest('mul', () => assert.equal(mul(2, 3), 6));\n");
    },
    review: (n) => (n === 1 ? { blocking: [{ file: 'src/math.js', line: 2, message: 'mul складывает вместо умножения', origin: null }], notes: [] } : { blocking: [], notes: [] }),
  });
  const core = makeCore(fake);
  const { runId } = await core.dispatch({ type: 'run.start', input: { projectPath: repo, task: 'Добавь функцию mul(a, b) в src/math.js и тест.', testCommand: 'node --test', mode: 'task', workspace: 'worktree' } as never });
  await untilGate(core, runId, 'gate1');
  await core.dispatch({ type: 'gate.approve', runId });
  const r = await untilGate(core, runId, 'gate2');

  const seq = r.attempts.filter((a) => a.stage !== 'gate1').map((a) => `${a.stage}:${a.status}`);
  assert.deepEqual(seq, ['clarify:done', 'plan:done', 'implement:done', 'tests:failed', 'review:failed', 'implement:done', 'tests:done', 'review:done', 'gate2:running']);
  // Вторая попытка получила и упавшие тесты, и замечание ревью — одним возвратом.
  const second = fake.prompts()[1];
  assert.match(second, /Тесты не прошли/);
  assert.match(second, /mul складывает вместо умножения/);
  // Первое ревью — с проверкой найденного вторым проходом: замечание подтверждено со сценарием.
  assert.match(r.reviews[0].blocking[0].message, /Сценарий: сценарий есть/);
  assert.equal(fake.reviews(), 2);
});

test('конвейер: «Поправить» с приёмки — правка и проверки, без ревью, снова приёмка', { skip: !hasOpenspec, timeout: 120_000 }, async () => {
  const repo = makeRepo();
  const fake = fakeClaude({
    implement: (n, cwd) => {
      const extra = n >= 2 ? 'export const sub = (a, b) => a - b;\n' : '';
      fs.writeFileSync(path.join(cwd, 'src/math.js'), `export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n${extra}`);
    },
    review: () => ({ blocking: [], notes: [] }),
  });
  const core = makeCore(fake);
  const { runId } = await core.dispatch({ type: 'run.start', input: { projectPath: repo, task: 'Добавь функцию mul(a, b) в src/math.js.', testCommand: 'node --test', mode: 'task', workspace: 'worktree', autopilot: true } as never });
  // Автопилот принимает план сам — сразу ждём приёмку.
  await untilGate(core, runId, 'gate2');
  await core.dispatch({ type: 'gate.fix', runId, comment: 'добавь sub' });
  const r = await untilGate(core, runId, 'gate2');
  const tail = r.attempts.slice(r.attempts.findIndex((a) => a.stage === 'gate2')).map((a) => `${a.stage}:${a.status}`);
  assert.deepEqual(tail, ['gate2:done', 'implement:done', 'tests:done', 'gate2:running']);
  assert.equal(fake.reviews(), 1);
  assert.match(fake.prompts()[1], /добавь sub/);
});
