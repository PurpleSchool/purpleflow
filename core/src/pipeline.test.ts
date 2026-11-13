import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.js';
import type { CoreSettings } from './types.js';
import { acceptTarget, afterChecks, availableActions, limitRow, plannedRoute, reviewInParallel, skippedStages } from './route.js';
import { loadLoginShellEnv, prependPath } from './env.js';
import type { AgentResult } from './agents/common.js';
import { parseReply } from './services/manager.js';
import type { RunFile, StageAttempt } from './types.js';

const at = (stage: StageAttempt['stage'], status: StageAttempt['status'] = 'done'): StageAttempt => ({
  stage,
  attempt: 1,
  startedAt: '2026-01-01T00:00:00Z',
  status,
});
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

test('route: какие действия управления доступны на ходу', () => {
  assert.deepEqual(availableActions(runOf({ next: 'plan', attempts: [at('plan', 'running')] })), ['note', 'pause']);
  const impl = runOf({ next: 'tests', attempts: [at('plan'), at('implement')] });
  assert.deepEqual(availableActions(impl), ['note', 'pause', 'restart', 'replan']);
  assert.deepEqual(availableActions({ ...impl, status: 'waiting', next: 'gate2' }), ['note', 'restart', 'replan']);
  // Быстрая правка с приёмки и быстрый режим — без возврата к плану; после двух возвратов — тоже.
  assert.ok(!availableActions({ ...impl, quickFix: true }).includes('restart'));
  assert.ok(!availableActions({ ...impl, mode: 'quick' }).includes('replan'));
  const twice = {
    ...impl,
    interventions: [
      { at: '1', kind: 'replan' as const },
      { at: '2', kind: 'replan' as const },
    ],
  };
  assert.ok(!availableActions(twice).includes('replan'));
  assert.deepEqual(availableActions({ ...impl, status: 'finished' }), []);
});

// ——— Конвейер целиком: настоящие git, openspec и тесты, фейковые агенты ———

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
// openspec — devDependency ядра: интеграционные тесты не зависят от глобальной установки.
const env = prependPath(
  loadLoginShellEnv(),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin'),
);
const hasOpenspec = (() => {
  try {
    execFileSync('openspec', ['--version'], { env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-pipe-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "p", "type": "module" }\n');
  fs.writeFileSync(path.join(dir, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(
    path.join(dir, 'test/math.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

const ok = (text: string): AgentResult => ({ ok: true, text, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

/** Фейковый claude: отвечает по роли (видно по промпту) и пишет файлы, как настоящий агент. */
function fakeClaude(script: {
  implement: (n: number, cwd: string, prompt: string) => void;
  review: (n: number) => object;
  manager?: (prompt: string) => string;
  checks?: string;
}) {
  let impl = 0;
  let rev = 0;
  const prompts: string[] = [];
  const plans: string[] = [];
  const fn = async (o: { prompt: string; cwd: string; systemPrompt?: string }): Promise<AgentResult> => {
    const p = o.prompt;
    const sys = o.systemPrompt ?? '';
    if (/Ты — менеджер прогона/.test(p)) return ok(script.manager?.(p) ?? '{"reply": "Всё идёт по плану.", "action": null}');
    if (/Перед планом проверь/.test(p)) return ok('{"questions": []}');
    if (/второй, независимый ревьюер/.test(p)) return ok('{"items":[{"index":1,"verdict":"confirmed","reason":"сценарий есть"}]}');
    if (/ревьюер в конвейере PurpleFlow/.test(p)) {
      rev++;
      return ok(JSON.stringify(script.review(rev)));
    }
    if (/планировщик/.test(sys)) {
      plans.push(p);
      const id = p.match(/используй ровно его\): `([^`]+)`/)![1];
      const d = path.join(o.cwd, 'openspec', 'changes', id);
      fs.mkdirSync(path.join(d, 'specs', 'calc'), { recursive: true });
      fs.writeFileSync(
        path.join(d, 'proposal.md'),
        '# Умножение\n\n## Why\nНужно умножать два числа, сейчас есть только сложение, и это неудобно.\n\n## What Changes\n- mul\n\n## Impact\n- `src/math.js`\n\n## Invariants\n- add работает\n' +
          (script.checks ? `\n## Checks\n- \`${script.checks}\`\n` : ''),
      );
      fs.writeFileSync(path.join(d, 'tasks.md'), '## 1. Код\n- [ ] 1.1 mul в src/math.js\n- [ ] 1.2 тест\n');
      fs.writeFileSync(
        path.join(d, 'specs', 'calc', 'spec.md'),
        '## ADDED Requirements\n### Requirement: Умножение\nКалькулятор SHALL умножать.\n\n#### Scenario: Два числа\n- **WHEN** mul(2, 3)\n- **THEN** 6\n',
      );
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
  return { fn, prompts: () => prompts, plans: () => plans, reviews: () => rev };
}

async function untilGate(core: Orchestrator, runId: string, gate: string, timeoutMs = 60_000): Promise<RunFile> {
  const t0 = Date.now();
  for (;;) {
    const r = (await core.getRun(runId))!;
    if (r.status === 'waiting' && r.next === gate) return r;
    if (r.status === 'stopped' || r.status === 'finished' || r.status === 'cancelled')
      throw new Error(`прогон остановился: ${r.message ?? r.status} (next=${r.next})`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались ${gate}, сейчас ${r.next}/${r.status}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

function makeCore(fake: ReturnType<typeof fakeClaude>) {
  // Сами запуски подменены, но ядро проверяет, что CLI установлен: в CI настоящего claude нет.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 5,
    testTimeoutMin: 2,
    maxParallel: 2,
  } as unknown as CoreSettings;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-data-'));
  return new Orchestrator({ dataDir, promptsDir: PROMPTS, env, getSettings: () => settings, runners: { claude: fake.fn as never } });
}

test(
  'конвейер: красные тесты и блокирующее ревью — один возврат, затем зелёное и приёмка',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    const fake = fakeClaude({
      implement: (n, cwd) => {
        // Первая попытка: mul с ошибкой и тест, который её ловит; вторая — исправление.
        fs.writeFileSync(
          path.join(cwd, 'src/math.js'),
          `export const add = (a, b) => a + b;\nexport const mul = (a, b) => ${n === 1 ? 'a + b' : 'a * b'};\n`,
        );
        fs.writeFileSync(
          path.join(cwd, 'test/mul.test.js'),
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mul } from '../src/math.js';\ntest('mul', () => assert.equal(mul(2, 3), 6));\n",
        );
      },
      review: (n) =>
        n === 1
          ? { blocking: [{ file: 'src/math.js', line: 2, message: 'mul складывает вместо умножения', origin: null }], notes: [] }
          : { blocking: [], notes: [] },
    });
    const core = makeCore(fake);
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js и тест.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
      } as never,
    });
    await untilGate(core, runId, 'gate1');
    await core.dispatch({ type: 'gate.approve', runId });
    const r = await untilGate(core, runId, 'gate2');

    const seq = r.attempts.filter((a) => a.stage !== 'gate1').map((a) => `${a.stage}:${a.status}`);
    assert.deepEqual(seq, [
      'clarify:done',
      'plan:done',
      'baseline:done',
      'implement:done',
      'tests:failed',
      'review:failed',
      'implement:done',
      'tests:done',
      'review:done',
      'gate2:running',
    ]);
    // Вторая попытка получила и упавшие тесты, и замечание ревью — одним возвратом.
    const second = fake.prompts()[1];
    assert.match(second, /Тесты не прошли/);
    assert.match(second, /mul складывает вместо умножения/);
    // Первое ревью — с проверкой найденного вторым проходом: замечание подтверждено со сценарием.
    assert.match(r.reviews[0].blocking[0].message, /Сценарий: сценарий есть/);
    assert.equal(fake.reviews(), 2);
  },
);

test(
  'эталон в фоне: линтер — с уточнения, тесты задачи из «## Checks» — пока человек смотрит план; полный набор — один раз перед приёмкой',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    const focus = 'node --test test/';
    const fake = fakeClaude({
      checks: focus,
      implement: (_n, cwd) =>
        fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
      review: () => ({ blocking: [], notes: [] }),
    });
    const base = fake.fn;
    let planSawLint: boolean | undefined;
    // eslint-disable-next-line prefer-const -- присваивается ниже, а читается в замыкании выше
    let core: Orchestrator;
    fake.fn = async (o) => {
      if (/Перед планом проверь/.test(o.prompt)) {
        await new Promise((r) => setTimeout(r, 50));
        return ok('{"questions": [{"q": "Какие числа поддерживать?"}]}');
      }
      if (/планировщик/.test(o.systemPrompt ?? ''))
        planSawLint = Boolean((await core.getRun(runId))?.baseChecks?.some((b) => b.kind === 'lint'));
      return base(o);
    };
    core = makeCore(fake);
    const lint = 'node -e "setTimeout(() => {}, 400)"';
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        lintCommand: lint,
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
      } as never,
    });
    const until = async (pred: (r: RunFile) => boolean) => {
      for (let i = 0; i < 150; i++) {
        const r = (await core.getRun(runId))!;
        if (pred(r)) return r;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error('не дождались');
    };
    const waiting = await untilGate(core, runId, 'gate0');
    // Уточнение не ждало линтер: оно закончилось раньше него.
    const [b, cl] = ['baseline', 'clarify'].map((st) => waiting.attempts.find((a) => a.stage === st)!);
    assert.ok(b.startedAt <= cl.startedAt);
    // Пока человек думает над вопросами, линтер до правок уже в эталоне, а его вывод — в логе одним куском. Тестов в эталоне ещё нет.
    let r = await until((x) => x.attempts[0].status === 'done');
    assert.equal(r.status, 'waiting');
    assert.deepEqual(
      r.baseChecks?.map((x) => `${x.kind}:${x.command}`),
      [`lint:${lint}`],
    );
    assert.match(await core.getLog(runId), /Базовые проверки · в фоне[\s\S]*✓ линтер: ok/);

    await core.dispatch({ type: 'gate.answer', runId, answers: [{ q: 'Какие числа поддерживать?', a: 'целые' }] } as never);
    await untilGate(core, runId, 'gate1');
    assert.equal(planSawLint, true);
    // Пока план ждёт утверждения, тесты задачи из «## Checks» снимаются на коде до правок.
    r = await until(
      (x) =>
        x.attempts.filter((a) => a.stage === 'baseline').every((a) => a.status === 'done') &&
        x.attempts.filter((a) => a.stage === 'baseline').length === 2,
    );
    assert.equal(r.focusTestCommand, focus);
    assert.deepEqual(
      r.baseChecks?.map((x) => `${x.kind}:${x.command}`),
      [`lint:${lint}`, `test:${focus}`],
    );

    await core.dispatch({ type: 'gate.approve', runId });
    const done = await untilGate(core, runId, 'gate2');
    const log = await core.getLog(runId);
    // На попытке — тесты задачи, полный набор — один раз, перед приёмкой.
    assert.equal(log.match(/полный набор перед приёмкой/g)?.length, 1);
    assert.deepEqual(
      done.tests.at(-1)!.checks!.map((x) => `${x.kind}:${x.command}`),
      [`lint:${lint}`, 'test:node --test'],
    );
    assert.ok(done.tests.at(-1)!.passed);
  },
);

test(
  'конвейер: «Поправить» с приёмки — правка и проверки, без ревью, снова приёмка',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    const fake = fakeClaude({
      implement: (n, cwd) => {
        const extra = n >= 2 ? 'export const sub = (a, b) => a - b;\n' : '';
        fs.writeFileSync(
          path.join(cwd, 'src/math.js'),
          `export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n${extra}`,
        );
      },
      review: () => ({ blocking: [], notes: [] }),
    });
    const core = makeCore(fake);
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
        autopilot: true,
      } as never,
    });
    // Автопилот принимает план сам — сразу ждём приёмку.
    await untilGate(core, runId, 'gate2');
    await core.dispatch({ type: 'gate.fix', runId, comment: 'добавь sub' });
    const r = await untilGate(core, runId, 'gate2');
    const tail = r.attempts.slice(r.attempts.findIndex((a) => a.stage === 'gate2')).map((a) => `${a.stage}:${a.status}`);
    assert.deepEqual(tail, ['gate2:done', 'implement:done', 'tests:done', 'gate2:running']);
    assert.equal(fake.reviews(), 1);
    assert.match(fake.prompts()[1], /добавь sub/);
  },
);

test(
  'управление: заметка на плане уходит исполнителю, возврат к плану откатывает код и сохраняет снимок',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    const fake = fakeClaude({
      implement: (_n, cwd) =>
        fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
      review: () => ({ blocking: [], notes: [] }),
    });
    const core = makeCore(fake);
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
      } as never,
    });
    await untilGate(core, runId, 'gate1');
    await core.dispatch({ type: 'run.control', runId, action: { kind: 'note', text: 'назови параметры x и y' } });
    await core.dispatch({ type: 'gate.approve', runId });
    let r = await untilGate(core, runId, 'gate2');
    assert.match(fake.prompts()[0], /назови параметры x и y/);
    assert.equal(r.pending, undefined);
    assert.ok(r.interventions?.[0].appliedAt);

    await core.dispatch({ type: 'run.control', runId, action: { kind: 'replan', text: 'mul не нужен, сделай pow', keepCode: false } });
    r = await untilGate(core, runId, 'gate1');
    // Код откачен к базе, план остался; работа до отката — в снимке.
    assert.equal(fs.readFileSync(path.join(r.worktreePath, 'src/math.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
    assert.ok(fs.existsSync(path.join(r.worktreePath, 'openspec', 'changes', r.changeId, 'tasks.md')));
    const snap = execFileSync('git', ['show', `${r.interventions!.at(-1)!.snapshot}:src/math.js`], { cwd: r.worktreePath }).toString();
    assert.match(snap, /mul/);
    assert.match(fake.plans().at(-1)!, /mul не нужен, сделай pow/);
    assert.match(fake.plans().at(-1)!, /src\/math\.js/);
    assert.equal(r.implAttemptsLimit, r.implAttemptsUsed + 3);
    // Исполнитель после нового плана узнаёт, почему план поменялся.
    await core.dispatch({ type: 'gate.approve', runId });
    await untilGate(core, runId, 'gate2');
    assert.match(fake.prompts().at(-1)!, /План обновлён.*сделай pow/s);
  },
);

test(
  'управление: заметка и пауза, отправленные во время идущей стадии, не теряются',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    const fake = fakeClaude({
      implement: (_n, cwd) =>
        fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
      review: () => ({ blocking: [], notes: [] }),
    });
    // Агент «работает», пока тест не разрешит закончить: команды приходят посреди стадии.
    let inStage: (role: 'plan' | 'impl') => void = () => {};
    const stageStarted = (role: 'plan' | 'impl') => new Promise<void>((res) => (inStage = (r) => r === role && res()));
    let release = () => {};
    const hold = () => new Promise<void>((res) => (release = res));
    const blocked = {
      ...fake,
      fn: async (o: Parameters<typeof fake.fn>[0]) => {
        const sys = o.systemPrompt ?? '';
        const role = /планировщик/.test(sys) ? 'plan' : /исполнитель/.test(sys) ? 'impl' : null;
        if (role) {
          const wait = hold();
          inStage(role);
          await wait;
        }
        return fake.fn(o);
      },
    };
    const core = makeCore(blocked);
    const planning = stageStarted('plan');
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
      } as never,
    });
    await planning;
    await core.dispatch({ type: 'run.control', runId, action: { kind: 'note', text: 'назови параметры x и y' } });
    release();
    let r = await untilGate(core, runId, 'gate1');
    assert.equal(r.pending?.length, 1, 'заметка пережила сохранения стадии');
    assert.equal(r.interventions?.length, 1);

    const implementing = stageStarted('impl');
    await core.dispatch({ type: 'gate.approve', runId });
    await implementing;
    assert.match(fake.prompts().join('') + (await core.getRun(runId))!.feedback?.text, /назови параметры x и y/);
    await core.dispatch({ type: 'run.control', runId, action: { kind: 'pause' } });
    release();
    for (let i = 0; i < 300 && (await core.getRun(runId))!.status === 'running'; i++) await new Promise((res) => setTimeout(res, 100));
    r = (await core.getRun(runId))!;
    assert.equal(r.status, 'stopped');
    assert.match(r.message ?? '', /Пауза/);
    assert.equal(r.next, 'tests');
    assert.equal(r.pending, undefined);
  },
);

test('удаление: запоздалое сохранение из стадии не возвращает прогон', { skip: !hasOpenspec, timeout: 120_000 }, async () => {
  const repo = makeRepo();
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const core = makeCore(fake);
  const { runId } = await core.dispatch({
    type: 'run.start',
    input: { projectPath: repo, task: 'Задача', testCommand: 'node --test', mode: 'task', workspace: 'worktree' } as never,
  });
  const r = await untilGate(core, runId, 'gate1');
  const k = (core as unknown as { kernel: { save: (x: RunFile) => void; store: { load: (id: string) => RunFile | null } } }).kernel;
  await core.dispatch({ type: 'run.delete', runId } as never);
  k.save(r);
  assert.equal(k.store.load(runId), null);
  assert.ok(!(await core.listRuns()).some((x) => x.id === runId));
});

test(
  'продолжение: пока изменения прогона в stash и не возвращаются, дальше не идём; вернулись — идём',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
    const core = makeCore(fake);
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: { projectPath: repo, task: 'Задача', testCommand: 'node --test', mode: 'task', workspace: 'worktree' } as never,
    });
    await untilGate(core, runId, 'gate1');
    const k = (core as unknown as { kernel: { save: (x: RunFile) => void; store: { load: (id: string) => RunFile } } }).kernel;
    const run = k.store.load(runId);
    run.status = 'stopped';
    // Несуществующий stash: возврат заведомо не удастся.
    run.baseProbeStash = '0'.repeat(40);
    k.save(run);
    await assert.rejects(core.dispatch({ type: 'run.resume', runId } as never), /git stash/);
    assert.equal(k.store.load(runId).status, 'stopped');
    assert.ok(k.store.load(runId).baseProbeStash);

    // Настоящий stash возвращается, и прогон идёт дальше.
    const file = path.join(run.worktreePath, 'src/math.js');
    fs.appendFileSync(file, '// работа прогона\n');
    const g = (...a: string[]) => execFileSync('git', a, { cwd: run.worktreePath }).toString().trim();
    g('stash', 'push', '-m', 'проба', '--', 'src/math.js');
    run.baseProbeStash = g('stash', 'list', '--format=%H').split('\n')[0];
    k.save(run);
    await core.dispatch({ type: 'run.resume', runId } as never);
    assert.match(fs.readFileSync(file, 'utf8'), /работа прогона/);
    assert.equal(k.store.load(runId).baseProbeStash, undefined);
  },
);

test(
  'завершение: приёмка — коммит в ветке с архивом OpenSpec, файлы окружения не в коммите; затем слияние',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    const fake = fakeClaude({
      implement: (_n, cwd) =>
        fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
      review: () => ({ blocking: [], notes: [] }),
    });
    const core = makeCore(fake);
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: { projectPath: repo, task: 'Добавь mul', testCommand: 'node --test', mode: 'task', workspace: 'worktree' } as never,
    });
    await untilGate(core, runId, 'gate1');
    await core.dispatch({ type: 'gate.approve', runId });
    await untilGate(core, runId, 'gate2');
    await core.dispatch({ type: 'gate.approve', runId });
    let r = (await core.getRun(runId))!;
    // finished пишется до коммита (чтобы попасть в run.json ветки), поэтому ждём и sha.
    for (let i = 0; i < 300 && !r.commit; i++) {
      assert.notEqual(r.status, 'stopped', r.message);
      await new Promise((res) => setTimeout(res, 100));
      r = (await core.getRun(runId))!;
    }
    assert.equal(r.status, 'finished');
    assert.ok(r.commit);
    assert.ok(r.archivedPath && fs.existsSync(r.archivedPath), 'run.json в архиве изменения');

    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo }).toString();
    const changed = g('show', '--name-only', '--format=', r.commit).split('\n');
    assert.ok(changed.includes('src/math.js'));
    assert.ok(changed.some((f) => f.startsWith('openspec/changes/archive/')));
    assert.ok(!changed.includes('.env'), 'секреты разработчика не попадают в коммит');
    assert.match(g('log', '-1', '--format=%B', r.commit), /PurpleFlow run: /);
    assert.match(g('show', 'main:src/math.js'), /^export const add = \(a, b\) => a \+ b;\n$/, 'до слияния основная ветка не тронута');

    // Дифф завершённого прогона — из ветки: тот же файл, без служебного run.json.
    const diff = await core.getDiff(runId);
    assert.ok(diff.some((f) => f.path === 'src/math.js'));
    assert.ok(!diff.some((f) => f.path.endsWith('/run.json')));

    await core.dispatch({ type: 'run.merge', runId, target: 'main' });
    r = (await core.getRun(runId))!;
    assert.equal(r.merged?.into, 'main');
    assert.match(g('show', 'main:src/math.js'), /mul/);
  },
);

test('автопилот: «Стоп» в паузе перед решением — план никто не принимает', { skip: !hasOpenspec, timeout: 60_000 }, async () => {
  const repo = makeRepo();
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const core = makeCore(fake);
  const { runId } = await core.dispatch({
    type: 'run.start',
    input: {
      projectPath: repo,
      task: 'Добавь mul',
      testCommand: 'node --test',
      mode: 'task',
      workspace: 'worktree',
      autopilot: true,
    } as never,
  });
  await untilGate(core, runId, 'gate1');
  await core.dispatch({ type: 'run.stop', runId });
  await new Promise((res) => setTimeout(res, 1100));
  const r = (await core.getRun(runId))!;
  assert.equal(r.status, 'stopped');
  assert.equal(r.next, 'gate1');
  assert.equal(fake.prompts().length, 0, 'исполнитель не запускался');
});

test('менеджер: разбор ответа модели — JSON с действием, JSON в блоке кода, просто текст', () => {
  assert.deepEqual(parseReply('{"reply": "Верну к плану.", "action": {"kind": "replan", "text": "без mul"}}'), {
    reply: 'Верну к плану.',
    action: { kind: 'replan', text: 'без mul', keepCode: true },
  });
  assert.deepEqual(parseReply('Вот:\n```json\n{"reply": "Ок", "action": {"kind": "pause"}}\n```'), {
    reply: 'Ок',
    action: { kind: 'pause' },
  });
  // Действие без текста указания не принимаем.
  assert.deepEqual(parseReply('{"reply": "Ок", "action": {"kind": "note", "text": " "}}'), { reply: 'Ок', action: undefined });
  assert.deepEqual(parseReply('Просто ответ'), { reply: 'Просто ответ' });
  // Блок кода внутри reply — не сам JSON (так ломалось: брали ```bash за ответ).
  const withCode = JSON.stringify({
    reply: 'Сделайте так:\n```bash\ngit tag v1\n```',
    action: { kind: 'command', command: 'git tag v1.0.1', text: 'тег', cwd: 'project' },
  });
  assert.deepEqual(parseReply(withCode), {
    reply: 'Сделайте так:\n```bash\ngit tag v1\n```',
    action: { kind: 'command', command: 'git tag v1.0.1', text: 'тег', cwd: 'project' },
  });
  assert.deepEqual(parseReply('```json\n{"reply": "Ок", "action": null}\n```'), { reply: 'Ок', action: undefined });
});

test(
  'менеджер: видит факты прогона, предлагает действие, человек применяет кнопкой',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = makeRepo();
    let seen = '';
    const fake = fakeClaude({
      implement: (_n, cwd) =>
        fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
      review: () => ({ blocking: [], notes: [] }),
      manager: (p) => {
        seen = p;
        return '{"reply": "Верну на план.", "action": {"kind": "replan", "text": "сделай pow вместо mul"}}';
      },
    });
    const core = makeCore(fake);
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
        autopilot: true,
      } as never,
    });
    await untilGate(core, runId, 'gate2');
    const chat = await core.askManager(runId, 'Давай лучше pow');
    assert.match(seen, /mul в src\/math\.js/); // tasks.md в фактах
    assert.match(seen, /src\/math\.js/);
    assert.match(seen, /`replan`/);
    const proposal = chat.at(-1)!;
    assert.equal(proposal.actionState, 'proposed');
    assert.equal((await core.getRun(runId))!.next, 'gate2'); // само ничего не применилось
    await core.resolveManagerAction(runId, proposal.id, true);
    const r = await untilGate(core, runId, 'gate1'); // автопилот после возврата к плану ждёт человека
    assert.equal(r.interventions?.at(-1)?.kind, 'replan');
    assert.equal((await core.getManagerChat(runId)).messages.at(-1)!.actionState, 'applied');
  },
);

test('менеджер: команда выполняется только по кнопке, вывод возвращается в чат', { skip: !hasOpenspec, timeout: 120_000 }, async () => {
  const repo = makeRepo();
  execFileSync('git', ['tag', 'v1.0.0'], { cwd: repo });
  let seen = '';
  const fake = fakeClaude({
    implement: (_n, cwd) =>
      fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
    review: () => ({ blocking: [], notes: [] }),
    manager: (p) => {
      seen = p;
      return JSON.stringify({
        reply: 'Поставлю тег.',
        action: { kind: 'command', command: 'git tag v1.0.1 && git tag --list', text: 'тег v1.0.1', cwd: 'project' },
      });
    },
  });
  const core = makeCore(fake);
  const { runId } = await core.dispatch({
    type: 'run.start',
    input: {
      projectPath: repo,
      task: 'Добавь функцию mul(a, b) в src/math.js.',
      testCommand: 'node --test',
      mode: 'task',
      workspace: 'worktree',
      autopilot: true,
    } as never,
  });
  await untilGate(core, runId, 'gate2');
  const chat = await core.askManager(runId, 'Поставь тег на следующую fix-версию');
  assert.match(seen, /v1\.0\.0/); // теги проекта в фактах
  assert.equal(execFileSync('git', ['tag', '--list'], { cwd: repo }).toString().trim(), 'v1.0.0'); // без кнопки — ничего
  const after = await core.resolveManagerAction(runId, chat.at(-1)!.id, true);
  assert.equal(after.at(-1)!.result?.code, 0);
  assert.match(after.at(-1)!.result!.output, /v1\.0\.1/);
  assert.match(execFileSync('git', ['tag', '--list'], { cwd: repo }).toString(), /v1\.0\.1/);
});

test(
  'соседние репозитории: агенты видят их на чтение, запись исполнителя туда — предупреждение',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    // Прогон хранит настоящий путь проекта (/private/var… на macOS) — настройки сохраняем по нему же.
    const repo = fs.realpathSync(makeRepo());
    const api = fs.realpathSync(makeRepo());
    const fake = fakeClaude({
      implement: (_n, cwd) => {
        fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
        // Исполнитель нарушил запрет и поправил соседа.
        fs.writeFileSync(path.join(api, 'src/math.js'), 'export const add = (a, b) => b + a;\n');
      },
      review: () => ({ blocking: [], notes: [] }),
    });
    const calls: { addDirs?: string[]; systemPrompt?: string; prompt: string }[] = [];
    const fn = fake.fn;
    fake.fn = (async (o: { prompt: string; cwd: string; systemPrompt?: string; addDirs?: string[] }) => {
      calls.push(o);
      return fn(o);
    }) as typeof fn;
    const core = makeCore(fake);
    await core.saveProjectConfig(repo, {
      setupCommand: '',
      lintCommand: '',
      testCommand: 'node --test',
      relatedRepos: [{ path: api, note: 'бэкенд API' }, { path: path.join(api, 'нет-такой') }],
      notes: { setup: '', lint: '', test: '' },
    });
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
      } as never,
    });
    await untilGate(core, runId, 'gate1');
    await core.dispatch({ type: 'gate.approve', runId });
    const r = await untilGate(core, runId, 'gate2');

    const exec = calls.find((c) => /исполнитель/.test(c.systemPrompt ?? ''))!;
    assert.deepEqual(exec.addDirs, [api]);
    assert.match(exec.systemPrompt!, /Соседние репозитории \(только чтение\)[\s\S]*бэкенд API/);
    assert.ok(
      r.warnings?.some((w) => w.text.includes(api)),
      'запись в соседа замечена',
    );
  },
);

test(
  'только codex: прогон без claude, служебные вызовы и менеджер — на codex, визуальная проверка выключена',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = fs.realpathSync(makeRepo());
    const fake = fakeClaude({
      implement: (_n, cwd) =>
        fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
      review: () => ({ blocking: [], notes: [] }),
    });
    const sandboxes: string[] = [];
    const codex = (async (o: { prompt: string; cwd: string; systemPrompt?: string; sandbox: string }) => {
      sandboxes.push(o.sandbox);
      return fake.fn(o);
    }) as never;
    // codex «установлен» (скрипт отвечает версией), claude — нет.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-bin-'));
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 1.0.0"\n', { mode: 0o755 });
    const settings = {
      toolPaths: { codex: path.join(bin, 'codex'), claude: path.join(bin, 'нет-claude') },
      proxy: { baseUrl: '', apiKey: '' },
      models: { planner: '', executor: '', reviewer: '' },
      agents: { planner: 'codex', executor: 'codex', reviewer: 'codex' },
      agentTimeoutMin: 5,
      testTimeoutMin: 2,
      maxParallel: 2,
    } as unknown as CoreSettings;
    const core = new Orchestrator({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-data-')),
      promptsDir: PROMPTS,
      env,
      getSettings: () => settings,
      runners: {
        claude: (() => {
          throw new Error('claude не должен запускаться');
        }) as never,
        codex,
      },
    });

    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
        visual: true,
        runCommand: 'node -e 1',
        appUrl: 'http://localhost:{port}',
      } as never,
    });
    assert.equal((await core.getRun(runId))!.visual, undefined, 'без claude визуальной проверки нет');
    await untilGate(core, runId, 'gate1');
    await core.dispatch({ type: 'gate.approve', runId });
    await untilGate(core, runId, 'gate2');
    const chat = await core.askManager(runId, 'Как дела?');
    assert.equal(chat.at(-1)!.text, 'Всё идёт по плану.');
    assert.equal(sandboxes.at(-1), 'read-only');
  },
);

test('менеджер на codex по выбору в настройках, даже если claude установлен', { skip: !hasOpenspec, timeout: 120_000 }, async () => {
  const repo = fs.realpathSync(makeRepo());
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const calls: string[] = [];
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-bin-'));
  for (const n of ['codex', 'claude']) fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "${n} 1.0.0"\n`, { mode: 0o755 });
  const via = (name: string) =>
    (async (o: { prompt: string; cwd: string }) => {
      if (/Ты — менеджер прогона/.test(o.prompt)) calls.push(name);
      return fake.fn(o);
    }) as never;
  const settings = {
    toolPaths: { codex: path.join(bin, 'codex'), claude: path.join(bin, 'claude') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '', manager: 'gpt-mini' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude', manager: 'codex' },
    agentTimeoutMin: 5,
    testTimeoutMin: 2,
    maxParallel: 2,
  } as unknown as CoreSettings;
  const core = new Orchestrator({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-data-')),
    promptsDir: PROMPTS,
    env,
    getSettings: () => settings,
    runners: { claude: via('claude'), codex: via('codex') },
  });
  const { runId } = await core.dispatch({
    type: 'run.start',
    input: {
      projectPath: repo,
      task: 'Добавь функцию mul(a, b) в src/math.js.',
      testCommand: 'node --test',
      mode: 'task',
      workspace: 'worktree',
    } as never,
  });
  await untilGate(core, runId, 'gate1');
  await core.askManager(runId, 'Как дела?');
  assert.deepEqual(calls, ['codex']);
});

test(
  'менеджеру можно приложить скриншот: путь в промпте, Read и папка доступны, картинка отдаётся окну',
  { skip: !hasOpenspec, timeout: 120_000 },
  async () => {
    const repo = fs.realpathSync(makeRepo());
    const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
    const seen: { prompt: string; tools?: string[]; addDirs?: string[] }[] = [];
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-bin-'));
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
    const settings = {
      toolPaths: { claude: path.join(bin, 'claude') },
      proxy: { baseUrl: '', apiKey: '' },
      models: { planner: '', executor: '', reviewer: '' },
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      agentTimeoutMin: 5,
      testTimeoutMin: 2,
      maxParallel: 2,
    } as unknown as CoreSettings;
    const core = new Orchestrator({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-data-')),
      promptsDir: PROMPTS,
      env,
      getSettings: () => settings,
      runners: {
        claude: (async (o: { prompt: string; cwd: string; tools?: string[]; addDirs?: string[] }) => {
          if (/Ты — менеджер прогона/.test(o.prompt)) seen.push(o);
          return fake.fn(o);
        }) as never,
      },
    });
    const { runId } = await core.dispatch({
      type: 'run.start',
      input: {
        projectPath: repo,
        task: 'Добавь функцию mul(a, b) в src/math.js.',
        testCommand: 'node --test',
        mode: 'task',
        workspace: 'worktree',
      } as never,
    });
    await untilGate(core, runId, 'gate1');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await assert.rejects(core.askManager(runId, 'Смотри', [{ name: 'log.txt', data: png }]), /только изображения/);
    const chat = await core.askManager(runId, '', [{ name: 'Снимок экрана.png', data: png }]);
    const sent = chat.find((m) => m.role === 'user')!;
    assert.equal(sent.images?.length, 1);
    const file = sent.images![0];
    assert.ok(fs.existsSync(file));
    const call = seen.at(-1)!;
    assert.ok(call.prompt.includes(file), 'путь к картинке в промпте');
    assert.ok(call.tools?.includes('Read'));
    assert.ok(call.addDirs?.includes(path.dirname(file)));
    assert.match((await core.getManagerImage(runId, file))!, /^data:image\/png;base64,/);
    assert.equal(await core.getManagerImage(runId, path.join(repo, 'src/math.js')), null, 'чужие файлы окну не отдаются');
  },
);
