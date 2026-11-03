// Стадии «Проверки» и «Базовые проверки»: линтер и тесты, сравнение с исходным кодом, фоновый эталон.
import { c } from '../agents/common.js';
import { Git } from '../git.js';
import type { Kernel } from '../kernel.js';
import { MODE_LIMIT, QUICK_REVIEW_LINES, TEST_FILE } from '../modes.js';
import { errorCount, failedTestNames } from '../parse.js';
import { afterChecks, afterReview, epicHasMore, reviewInParallel } from '../route.js';
import type { BasePrep } from '../runtime.js';
import { CHECK_NAME, MAX_TEST_OUTPUT, RUN_JSON_GLOB, StopSignal } from '../runtime.js';
import { getProjectConfig } from '../services/projects.js';
import { diffBase, envFilesOf } from '../services/workspace.js';
import type { CheckResult, ReviewResult, RunFile, TestResult } from '../types.js';
import { reviewFeedback, reviewPass } from './review.js';
/** Линтер и тесты в worktree. Общий для «Проверок», базовых проверок и воспроизведения бага. */
export async function runChecks(
  k: Kernel,
  run: RunFile,
  testCommand = run.testCommand,
): Promise<{ result: TestResult; failed: CheckResult[] }> {
  const s = k.opts.getSettings();
  const plan: { kind: CheckResult['kind']; command: string }[] = [];
  if (run.lintCommand) plan.push({ kind: 'lint', command: run.lintCommand });
  if (testCommand) plan.push({ kind: 'test', command: testCommand });
  const checks: CheckResult[] = [];
  for (const p of plan) checks.push(await runCheck(k, run, p.kind, p.command, s.testTimeoutMin));
  const failed = checks.filter((x) => !x.passed);
  const result: TestResult = checks.length
    ? {
        at: new Date().toISOString(),
        command: checks.map((x) => x.command).join(' && '),
        passed: failed.length === 0,
        exitCode: failed[0]?.exitCode ?? 0,
        durationMs: checks.reduce((n, x) => n + x.durationMs, 0),
        output: checks.map((x) => `$ ${x.command}\n${x.output}`).join('\n\n'),
        timedOut: checks.some((x) => x.timedOut) || undefined,
        checks,
      }
    : {
        at: new Date().toISOString(),
        command: '',
        passed: true,
        exitCode: 0,
        durationMs: 0,
        output: 'Команды линтера и тестов не заданы — проверки пропущены.',
        checks: [],
      };
  if (!checks.length) k.log(run, c.amber(result.output) + '\n');
  return { result, failed };
}

export async function runCheck(
  k: Kernel,
  run: RunFile,
  kind: CheckResult['kind'],
  command: string,
  timeoutMin: number,
  note = '',
): Promise<CheckResult> {
  k.log(run, c.sky(`$ ${command}`) + c.dim(`  # ${CHECK_NAME[kind]}${note ? `, ${note}` : ''}`) + '\n');
  const r = await k.shell(run, command, timeoutMin);
  k.checkStop(run);
  const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
  const check: CheckResult = {
    kind,
    command,
    passed: r.code === 0 && !r.timedOut && !r.spawnError,
    exitCode: r.code,
    durationMs: r.durationMs,
    output: r.spawnError
      ? `Не удалось запустить: ${r.spawnError}`
      : output.length > MAX_TEST_OUTPUT
        ? '…\n' + output.slice(-MAX_TEST_OUTPUT)
        : output,
    timedOut: r.timedOut || undefined,
  };
  k.log(
    run,
    (check.passed
      ? c.mint(`✓ ${CHECK_NAME[kind]}: ok`)
      : c.coral(`✗ ${CHECK_NAME[kind]}: код ${check.exitCode}${check.timedOut ? ', таймаут' : ''}`)) + '\n',
  );
  return check;
}

/**
 * Красные тесты — это задача или нестабильность проекта? Повторяем их один раз; если падают те же тесты —
 * запускаем на исходном коде (изменения прогона на это время в stash). Не из‑за задачи — пометка unstable,
 * иначе — результат повтора (он свежее) для исполнителя.
 */
export async function probeTests(k: Kernel, run: RunFile, check: CheckResult, beforeStash?: Promise<unknown> | null): Promise<CheckResult> {
  const s = k.opts.getSettings();
  const first = failedTestNames(check.output);
  k.log(run, c.amber('↻ тесты красные — повторяю один раз, чтобы отличить нестабильный тест от настоящей ошибки') + '\n');
  const retry = await runCheck(k, run, 'test', check.command, s.testTimeoutMin, 'повтор');
  if (retry.passed) {
    k.log(
      run,
      c.amber(
        `! при повторе тесты прошли — нестабильные${first?.length ? `: ${first.join('; ')}` : ''}. Не блокирует, решение — на приёмке`,
      ) + '\n',
    );
    return { ...check, unstable: { reason: 'retry', tests: first ?? [] } };
  }
  if (retry.timedOut) return retry;
  const second = failedTestNames(retry.output);
  if (!first?.length || !second?.length) return retry;
  const stable = second.filter((t) => first.includes(t));
  if (!stable.length) {
    k.log(
      run,
      c.amber(
        `! при повторе упали другие тесты (${first.join('; ')} → ${second.join('; ')}) — нестабильные. Не блокирует, решение — на приёмке`,
      ) + '\n',
    );
    return { ...retry, unstable: { reason: 'differs', tests: [...new Set([...first, ...second])] } };
  }

  // Те же тесты падают дважды: проверяем их на исходном коде. Параллельное ревью читает рабочую копию —
  // прятать изменения можно только после него.
  if (beforeStash) {
    k.log(run, c.dim('Жду конца ревью, чтобы проверить тесты на исходном коде…') + '\n');
    await beforeStash;
    k.checkStop(run);
  }
  const git = new Git((await k.tools(['git'])).git, k.opts.env);
  const keep = [RUN_JSON_GLOB, ...envFilesOf(k, run)];
  const stash = await git.stashExcept(run.worktreePath, `PurpleFlow ${run.id}: проверка тестов на исходном коде`, keep).catch((e) => {
    k.warn(run, `Не удалось проверить тесты на исходном коде (git stash): ${(e as Error).message}`);
    return undefined;
  });
  // Прятать нечего (агент сам закоммитил работу): «исходный код» был бы тем же кодом, и падения выглядели бы унаследованными.
  if (!stash) return retry;
  run.baseProbeStash = stash;
  k.save(run);
  let base: CheckResult;
  try {
    base = await runCheck(k, run, 'test', check.command, s.testTimeoutMin, 'на исходном коде, без изменений задачи');
  } finally {
    // Не вернулось — baseProbeStash остаётся: «Продолжить» не пойдёт дальше на коде без изменений прогона.
    await git.restoreStash(run.worktreePath, stash).catch((e) => {
      throw new Error(
        `Не удалось вернуть изменения прогона после проверки на исходном коде. Они в git stash (${stash.slice(0, 8)}): ${(e as Error).message}`,
        { cause: e },
      );
    });
    run.baseProbeStash = undefined;
    k.save(run);
  }
  const onBase = base.passed ? [] : (failedTestNames(base.output) ?? []);
  const inherited = stable.filter((t) => onBase.includes(t));
  if (inherited.length === stable.length) {
    k.log(run, c.amber(`! эти тесты падают и без изменений задачи: ${stable.join('; ')}. Не блокирует, решение — на приёмке`) + '\n');
    return { ...retry, unstable: { reason: 'base', tests: stable } };
  }
  k.log(run, c.dim(`На исходном коде ${base.passed ? 'тесты зелёные' : `падают другие тесты`} — ошибка из‑за изменений задачи.`) + '\n');
  return retry;
}

export function checksFeedback(k: Kernel, failed: CheckResult[], base?: CheckResult[]): string {
  return failed
    .map((x) => {
      const before = base?.find((b) => b.kind === x.kind && !b.passed);
      const head = `${x.kind === 'lint' ? 'Линтер' : 'Тесты'} не прошли. Команда: \`${x.command}\`, код выхода ${x.exitCode}${x.timedOut ? ' (таймаут)' : ''}.`;
      // Проверка была красной и до задачи: просим исправить только новое, чужие старые ошибки не трогать.
      const delta = before
        ? `\n\nЭта проверка была красной ещё до задачи (ошибок: ${errorCount(before.output) ?? 'не удалось посчитать'}), сейчас — ${errorCount(x.output) ?? 'не удалось посчитать'}. Старые ошибки в чужом коде не исправляй — устрани только те, что появились из‑за твоих изменений, чтобы ошибок стало не больше, чем было.`
        : '';
      return `${head}${delta}\n\nВывод:\n\`\`\`\n${x.output}\n\`\`\``;
    })
    .join('\n\n');
}

/** Команда тестов на каждой попытке: выбранные планом, иначе быстрые из настроек проекта, иначе полный набор. */
export function iterationTestCommand(k: Kernel, run: RunFile): string {
  return run.focusTestCommand?.trim() || getProjectConfig(k, run.projectPath)?.quickTestCommand?.trim() || run.testCommand;
}

const hasBase = (run: RunFile, kind: CheckResult['kind'], command: string) =>
  Boolean(run.baseChecks?.some((b) => b.kind === kind && b.command === command));

/** Эталон копится по видам и командам: линтер снимается с уточнения, выбранные тесты — после плана. */
function mergeBase(run: RunFile, checks: CheckResult[]) {
  run.baseChecks = [...(run.baseChecks ?? []).filter((b) => !checks.some((x) => x.kind === b.kind && x.command === b.command)), ...checks];
}

/** Что из эталона ещё не снято: линтер и (если можно) тесты той команды, что пойдёт на попытках. */
function missingBase(k: Kernel, run: RunFile, withTests: boolean): { lint: boolean; test: string } {
  const lint = Boolean(run.lintCommand) && !hasBase(run, 'lint', run.lintCommand!);
  // В баге планировщик уже написал падающий тест: тесты после плана — не «код до задачи».
  const afterBugPlan = run.mode === 'bug' && run.attempts.some((a) => a.stage === 'plan');
  // После возврата к плану код уже с правками агента: снятое на нём — не «до задачи», его падения стали бы «старыми».
  const afterImplement = run.attempts.some((a) => a.stage === 'implement');
  const cmd = withTests && !afterBugPlan && !afterImplement ? iterationTestCommand(k, run) : '';
  return { lint, test: cmd && !hasBase(run, 'test', cmd) ? cmd : '' };
}

async function runBase(k: Kernel, run: RunFile, need: { lint: boolean; test: string }): Promise<CheckResult[]> {
  const s = k.opts.getSettings();
  const out: CheckResult[] = [];
  if (need.lint) out.push(await runCheck(k, run, 'lint', run.lintCommand!, s.testTimeoutMin, 'до правок'));
  if (need.test) out.push(await runCheck(k, run, 'test', need.test, s.testTimeoutMin, 'до правок'));
  return out;
}

function logRed(k: Kernel, run: RunFile, checks: CheckResult[]) {
  const red = checks.filter((x) => !x.passed);
  if (red.length)
    k.log(
      run,
      c.amber(
        `! красные ещё до задачи: ${red.map((x) => `${CHECK_NAME[x.kind]} (ошибок: ${errorCount(x.output) ?? '?'})`).join(', ')} — от агента потребуется не добавлять новых ошибок`,
      ) + '\n',
    );
}

/** Линтер и тесты на коде до правок — то, чего ещё нет в эталоне. Синхронно: когда фона не было. */
export async function captureBaseChecks(k: Kernel, run: RunFile, withTests = true) {
  const need = missingBase(k, run, withTests);
  if (!need.lint && !need.test) return;
  k.log(run, c.dim('Исходное состояние проверок (до правок агента):') + '\n');
  const checks = await runBase(k, run, need);
  mergeBase(run, checks);
  logRed(k, run, checks);
  k.save(run);
}

/** Фоновая подготовка: чем закончилась и что написала в лог. */
/**
 * Эталон в фоне, пока агент или человек заняты другим. 'clarify' — команда подготовки и линтер, параллельно с уточнением
 * (оно только читает код). 'plan' — выбранные планом тесты, пока человек смотрит план: код ещё не тронут.
 */
export function startBaseChecks(k: Kernel, run: RunFile, phase: 'clarify' | 'plan' = 'clarify') {
  const mode = run.mode;
  if (mode === 'quick' || mode === 'refactor' || k.basePrep.has(run.id)) return;
  const setup = phase === 'clarify' && !run.prepared && run.setupCommand ? run.setupCommand : '';
  const need = missingBase(k, run, phase === 'plan');
  if (phase === 'plan') need.lint = false;
  if (!setup && !need.lint && !need.test) return;
  k.begin(run, 'baseline', undefined, true);
  k.log(
    run,
    c.dim(
      phase === 'clarify'
        ? 'Параллельно с уточнением: подготовка и линтер до правок — вывод появится в логе, когда закончатся.'
        : `Пока вы смотрите план: тесты задачи на коде до правок (\`${need.test}\`) — вывод появится в логе, когда закончатся.`,
    ) + '\n',
  );
  const prep: BasePrep = { promise: Promise.resolve(), log: [] };
  const s = k.opts.getSettings();
  prep.promise = k.logHold
    .run(prep.log, async () => {
      let prepared = run.prepared;
      try {
        if (setup) {
          k.log(run, c.sky(`$ ${setup}`) + '\n');
          const r = await k.shell(run, setup, s.testTimeoutMin);
          k.checkStop(run);
          if (r.code !== 0) throw new Error(`Команда подготовки «${setup}» завершилась с кодом ${r.code}${r.timedOut ? ' (таймаут)' : ''}`);
          prepared = true;
        }
        prep.result = { at: new Date().toISOString(), checks: await runBase(k, run, need), prepared };
      } catch (e) {
        const stopped = e instanceof StopSignal || k.stopping.has(run.id);
        prep.result = {
          at: new Date().toISOString(),
          checks: [],
          prepared,
          error: stopped ? undefined : (e as Error).message || String(e),
          stopped,
        };
      }
    })
    .then(() => {
      // Прогон сейчас никто не ведёт (ждёт человека) — записываем итог в свежую копию с диска.
      if (k.basePrep.get(run.id) !== prep || k.driving.has(run.id)) return;
      const fresh = k.store.load(run.id);
      if (fresh) applyBase(k, fresh, prep);
    });
  k.basePrep.set(run.id, prep);
}

/** Итог фоновой подготовки — в прогон: эталон, отметка подготовки, строка «Базовые проверки» и вывод в лог. */
function applyBase(k: Kernel, run: RunFile, prep: BasePrep) {
  const res = prep.result;
  if (!res || prep.applied || k.basePrep.get(run.id) !== prep) return;
  prep.applied = true;
  if (res.stopped) {
    k.basePrep.delete(run.id);
    return;
  }
  if (prep.log.length) {
    k.log(run, '\n' + c.violet(c.bold('━━ Базовые проверки · в фоне')) + '\n');
    k.log(run, prep.log.join(''), false);
  }
  if (res.prepared) run.prepared = true;
  mergeBase(run, res.checks);
  logRed(k, run, res.checks);
  const red = res.checks.filter((x) => !x.passed);
  const a = [...run.attempts].reverse().find((x) => x.stage === 'baseline' && x.status === 'running');
  if (a) {
    Object.assign(
      a,
      res.error
        ? { status: 'failed', endedAt: res.at, error: res.error }
        : {
            status: 'done',
            endedAt: res.at,
            summary: red.length
              ? `Красные до задачи: ${red.map((x) => CHECK_NAME[x.kind]).join(' и ')}`
              : res.checks.length
                ? 'Эталон снят'
                : 'Подготовка готова',
          },
    );
  }
  if (!res.error) k.basePrep.delete(run.id);
  k.save(run);
}

/** Фон уже закончил — записать итог сразу, не дожидаясь следующей стадии (например, перед вопросами человеку). */
export function flushBaseChecks(k: Kernel, run: RunFile) {
  const prep = k.basePrep.get(run.id);
  if (prep?.result) applyBase(k, run, prep);
}

/**
 * Дождаться фоновой подготовки (перед планом и перед первой реализацией). Если фон оборвался вместе с приложением,
 * его строку закрываем — недостающее снимут синхронно captureBaseChecks.
 */
export async function settleBaseChecks(k: Kernel, run: RunFile) {
  const prep = k.basePrep.get(run.id);
  if (prep) {
    if (!prep.result) k.log(run, c.dim('Жду проверки до правок…') + '\n');
    await prep.promise;
    k.checkStop(run);
    applyBase(k, run, prep);
    k.basePrep.delete(run.id);
    if (prep.result?.error) throw new Error(prep.result.error);
  }
  if (run.mode !== 'refactor') {
    for (const a of run.attempts)
      if (a.stage === 'baseline' && a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
  }
  if (!run.prepared && run.setupCommand) {
    const s = k.opts.getSettings();
    k.log(run, c.sky(`$ ${run.setupCommand}`) + '\n');
    const r = await k.shell(run, run.setupCommand, s.testTimeoutMin);
    k.checkStop(run);
    if (r.code !== 0)
      throw new Error(`Команда подготовки «${run.setupCommand}» завершилась с кодом ${r.code}${r.timedOut ? ' (таймаут)' : ''}`);
    run.prepared = true;
    k.save(run);
  }
}

/** Большая задача: следующий этап реализации со свежим запасом попыток. false — этапов больше нет. */
export function startNextPhase(k: Kernel, run: RunFile): boolean {
  if (!epicHasMore(run)) return false;
  run.phase = (run.phase ?? 1) + 1;
  run.executorSession = undefined;
  run.implAttemptsUsed = 0;
  run.implAttemptsLimit = MODE_LIMIT.epic;
  k.log(run, c.violet(`→ этап ${run.phase} из ${run.phases}`) + '\n');
  run.next = 'implement';
  return true;
}

/** Красная проверка, которая была красной и до задачи и ошибок в ней не прибавилось, не блокирует. */
export function compareWithBase(k: Kernel, run: RunFile, result: TestResult): { result: TestResult; failed: CheckResult[] } {
  const checks = (result.checks ?? []).map((x) => {
    if (x.passed || x.timedOut) return x;
    const before = run.baseChecks?.find((b) => b.kind === x.kind && b.command === x.command && !b.passed);
    if (!before) return x;
    // Имена тестов надёжнее числа: задача могла починить один старый тест и сломать другой — счёт тот же.
    if (x.kind === 'test') {
      const was = failedTestNames(before.output);
      const now = failedTestNames(x.output);
      if (was && now && now.some((t) => !was.includes(t))) return x;
    }
    const a = errorCount(before.output);
    const b = errorCount(x.output);
    // Посчитать не удалось — сравниваем по коду выхода: тот же код считаем «тем же состоянием».
    const same = a != null && b != null ? b <= a : before.exitCode === x.exitCode;
    if (!same) return x;
    k.log(run, c.amber(`! ${CHECK_NAME[x.kind]}: красный и до задачи, новых ошибок нет (${a ?? '?'} → ${b ?? '?'}) — не блокирует`) + '\n');
    return { ...x, preexisting: { before: a, after: b } };
  });
  const failed = checks.filter((x) => !x.passed && !x.preexisting);
  return { result: { ...result, checks, passed: failed.length === 0, exitCode: failed[0]?.exitCode ?? 0 }, failed };
}

export async function stageTests(k: Kernel, run: RunFile) {
  const attempt = k.begin(run, 'tests');

  // Рефакторинг: тесты — эталон поведения, менять их нельзя.
  if (run.mode === 'refactor') {
    const tools = await k.tools(['git']);
    const changed = await new Git(tools.git, k.opts.env).changedFiles(run.worktreePath, run.baseCommit);
    const touched = changed.filter((f) => TEST_FILE.test(f) && !f.startsWith('openspec/'));
    if (touched.length) {
      k.log(run, c.coral(`✗ рефакторинг изменил тесты: ${touched.join(', ')}`) + '\n');
      k.end(run, attempt, 'failed', 'Изменены тесты');
      run.feedback = {
        source: 'tests',
        text: `Это рефакторинг: поведение и тесты менять нельзя. Верни эти файлы тестов к исходному виду (git checkout ${run.baseCommit.slice(0, 8)} -- <файл>) и добейся зелёных проверок без их правки:\n${touched.map((f) => `- ${f}`).join('\n')}`,
      };
      k.nextImplementOrLimit(run, 'Рефакторинг снова и снова меняет тесты.');
      return;
    }
  }

  // Ревью не нужен результат тестов — запускаем его одновременно с проверками: один круг вместо двух,
  // исполнитель получит и упавшие тесты, и замечания ревью одним возвратом.
  const review = await needsReview(k, run);
  const parallel = reviewInParallel(run, review);
  let reviewed: { review: ReviewResult; log: string } | null = null;
  let reviewErr: unknown = null;
  const reviewTask = parallel
    ? reviewPass(k, run, true).then(
        (r) => {
          reviewed = r;
        },
        (e) => {
          reviewErr = e;
        },
      )
    : null;
  if (parallel) k.log(run, c.dim('Ревью идёт параллельно с проверками — его лог появится после них.') + '\n');

  // Выбранные планом тесты (или быстрые из настроек проекта) — на каждом круге; полный набор — один раз,
  // когда всё остальное зелёное и ревью не вернуло задачу. У большой задачи — после последнего этапа.
  const quick = iterationTestCommand(k, run);
  const useQuick = Boolean(run.testCommand && quick !== run.testCommand);
  const lastPhase = !(run.mode === 'epic' && run.phases && (run.phase ?? 1) < run.phases);
  const probe = async (r: TestResult, f: CheckResult[]) => {
    const red = f.find((x) => x.kind === 'test' && !x.timedOut);
    if (!red) return { result: r, failed: f };
    const probed = await probeTests(k, run, red, reviewTask);
    const checks = (r.checks ?? []).map((x) => (x === red ? probed : x));
    const failedNow = checks.filter((x) => !x.passed && !x.preexisting && !x.unstable);
    return {
      result: {
        ...r,
        checks,
        passed: failedNow.length === 0,
        exitCode: failedNow[0]?.exitCode ?? 0,
        output: checks.map((x) => `$ ${x.command}\n${x.output}`).join('\n\n'),
      },
      failed: failedNow,
    };
  };

  let result: TestResult;
  let failed: CheckResult[];
  try {
    if (useQuick)
      k.log(
        run,
        c.dim(
          `${run.focusTestCommand ? 'Тесты задачи' : 'Быстрые проверки'}: \`${quick}\` — полный набор \`${run.testCommand}\` пойдёт перед приёмкой, когда остальное будет зелёным.`,
        ) + '\n',
      );
    const raw = await runChecks(k, run, useQuick ? quick : run.testCommand);
    ({ result, failed } = await probe(...(Object.values(compareWithBase(k, run, raw.result)) as [TestResult, CheckResult[]])));
    if (useQuick && result.passed && lastPhase) {
      // Полный набор — после ревью: если ревьюер вернёт задачу, гонять его сейчас незачем.
      if (reviewTask && !reviewed && !reviewErr) {
        k.log(run, c.dim('Быстрые проверки зелёные — жду ревью, чтобы решить, нужен ли полный набор…') + '\n');
        await reviewTask;
      }
      const reviewBlocks = Boolean((reviewed as { review: ReviewResult } | null)?.review.blocking.length);
      if (!reviewErr && !reviewBlocks) {
        const s = k.opts.getSettings();
        const full = await runCheck(k, run, 'test', run.testCommand, s.testTimeoutMin, 'полный набор перед приёмкой');
        const checks = [...(result.checks ?? []).filter((x) => x.kind !== 'test'), full];
        const merged: TestResult = {
          ...result,
          checks,
          command: checks.map((x) => x.command).join(' && '),
          passed: checks.every((x) => x.passed),
          exitCode: full.exitCode,
          durationMs: checks.reduce((n, x) => n + x.durationMs, 0),
          output: checks.map((x) => `$ ${x.command}\n${x.output}`).join('\n\n'),
        };
        ({ result, failed } = await probe(...(Object.values(compareWithBase(k, run, merged)) as [TestResult, CheckResult[]])));
      }
    }
    run.tests.push(result);
    k.emit({ type: 'tests.result', runId: run.id, result });
    const checks = result.checks ?? [];
    const summary = !checks.length
      ? 'Пропущены'
      : failed.length
        ? `Красные: ${failed.map((x) => CHECK_NAME[x.kind]).join(' и ')}`
        : checks.some((x) => x.preexisting || x.unstable)
          ? checks
              .map((x) => `${CHECK_NAME[x.kind]}${x.preexisting ? ' — как до задачи' : x.unstable ? ' — нестабильные' : ' — ok'}`)
              .join(', ')
              .replace(/^./, (m) => m.toUpperCase())
          : checks
              .map((x) => CHECK_NAME[x.kind])
              .join(' и ')
              .replace(/^./, (m) => m.toUpperCase()) + ' — ok';
    k.end(run, attempt, result.passed ? 'done' : 'failed', summary);
  } finally {
    if (reviewTask) {
      if (!reviewed) k.log(run, c.dim('Проверки закончились — жду ревью…') + '\n');
      await reviewTask;
      if (reviewed) k.log(run, (reviewed as { log: string }).log, false);
    }
  }
  if (reviewErr) throw reviewErr;

  if (parallel) {
    const review = (reviewed as { review: ReviewResult } | null)!.review;
    if (result.passed && !review.blocking.length) {
      run.feedback = undefined;
      run.next = afterReview(run);
      k.save(run);
      return;
    }
    const parts = [
      result.passed ? '' : checksFeedback(k, failed, run.baseChecks),
      review.blocking.length ? reviewFeedback(k, review) : '',
    ].filter(Boolean);
    run.feedback = { source: result.passed ? 'review' : 'tests', text: parts.join('\n\n---\n\n') };
    const why =
      !result.passed && review.blocking.length
        ? 'Проверки красные и ревьюер оставил блокирующие замечания'
        : !result.passed
          ? 'Проверки красные'
          : 'Ревьюер оставил блокирующие замечания';
    k.nextImplementOrLimit(run, `${why}, а ${run.implAttemptsUsed} попытки реализации исчерпаны.`);
    return;
  }

  if (result.passed) {
    run.feedback = undefined;
    // Большая задача: следующий этап реализации со свежим запасом попыток.
    if (startNextPhase(k, run)) {
      k.save(run);
      return;
    }
    // Маршрут — в route.ts: слияние базовой ветки — сразу в PR, быстрая правка и конфликты — к человеку, иначе ревью.
    run.next = afterChecks(run, review);
    run.mergeOnly = undefined;
    run.quickFix = undefined;
    k.save(run);
    return;
  }
  run.feedback = { source: 'tests', text: checksFeedback(k, failed, run.baseChecks) };
  if (run.mergeOnly) {
    // После слияния базовой ветки проверки покраснели — чинит исполнитель, результат — на приёмку.
    run.mergeOnly = undefined;
    run.roundFiles = undefined;
    run.implAttemptsLimit = Math.max(run.implAttemptsLimit, run.implAttemptsUsed + 3);
    run.feedback.text = `В ветку влита свежая ${run.pr?.base ?? 'базовая ветка'}, и проверки покраснели. Почини так, чтобы работали и изменения задачи, и новый код базовой ветки.\n\n${run.feedback.text}`;
  }
  k.nextImplementOrLimit(run, `Проверки красные после ${run.implAttemptsUsed} попыток реализации.`);
}

/** Рефакторинг начинается с зелёных проверок: иначе нечем доказать, что поведение не изменилось. */
export async function stageBaseline(k: Kernel, run: RunFile) {
  const s = k.opts.getSettings();
  const attempt = k.begin(run, 'baseline');
  if (!run.prepared && run.setupCommand) {
    k.log(run, c.sky(`$ ${run.setupCommand}`) + '\n');
    const r = await k.shell(run, run.setupCommand, s.testTimeoutMin);
    k.checkStop(run);
    if (r.code !== 0)
      throw new Error(`Команда подготовки «${run.setupCommand}» завершилась с кодом ${r.code}${r.timedOut ? ' (таймаут)' : ''}`);
    run.prepared = true;
  }
  const { result } = await runChecks(k, run);
  run.repro = result;
  run.baseChecks = result.checks ?? [];
  if (!result.checks?.length) {
    k.end(run, attempt, 'failed', 'Нет проверок');
    k.markStopped(
      run,
      'Для рефакторинга нужны команды линтера или тестов — без них нельзя доказать, что поведение не изменилось. Задайте их в командах проекта.',
    );
    return;
  }
  if (!result.passed) {
    k.end(run, attempt, 'failed', 'Красные до начала');
    k.markStopped(run, 'Проверки красные ещё до рефакторинга. Почините их отдельной задачей (режим «Баг»), затем повторите рефакторинг.');
    return;
  }
  k.end(run, attempt, 'done', 'Зелёные — эталон зафиксирован');
  run.next = 'clarify';
  k.save(run);
}

/** После проверок — ревью; быстрая правка с маленьким диффом идёт без него (сразу к визуальной проверке или приёмке). */
/** Нужно ли ревью: у быстрой правки с маленьким диффом — нет (размер диффа знает только ядро). */
export async function needsReview(k: Kernel, run: RunFile): Promise<boolean> {
  if (run.mode !== 'quick') return true;
  const tools = await k.tools(['git']);
  const diff = await new Git(tools.git, k.opts.env).diffText(run.worktreePath, diffBase(k, run), [RUN_JSON_GLOB, ...envFilesOf(k, run)]);
  const lines = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
  if (lines > QUICK_REVIEW_LINES) return true;
  k.log(run, c.dim(`Дифф ${lines} строк — ревью пропущено (быстрая правка).`) + '\n');
  return false;
}
