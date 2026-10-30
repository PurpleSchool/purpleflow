// Движок прогона: цикл стадий, очередь, гейты и решения человека, жизненный цикл.
import { RUN_VERSION } from './migrate.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { c, emptyUsage } from './agents/common.js';
import { Git } from './git.js';
import { makeChangeId, makeTitle, runBranch } from './ids.js';
import type { Kernel } from './kernel.js';
import { MODE_FIRST, MODE_LIMIT } from './modes.js';
import { killGroup, killPid } from './proc.js';
import { acceptTarget, afterChecks } from './route.js';
import { IMPL_LIMIT, StopSignal } from './runtime.js';
import { attachmentsDir, saveAttachments } from './services/attachments.js';
import { applyPending } from './services/control.js';
import { stopPreview } from './services/preview.js';
import { getProjectConfig } from './services/projects.js';
import { getChangeDocs, runsWithFiles } from './services/runs.js';
import { copyEnvFiles, ensureOnBranch, prepareWorkspace } from './services/workspace.js';
import { STAGE_TITLES, isGate } from './stage-info.js';
import { needsReview, stageBaseline, stageTests } from './stages/checks.js';
import { stageFinish } from './stages/finish.js';
import { stageImplement } from './stages/implement.js';
import { stageClarify, stagePlan } from './stages/plan.js';
import { mapFilesToPlan, stageReview, summarizeChanges } from './stages/review.js';
import { stageVisual } from './stages/visual.js';
import type { AgentKind, Feedback, GateId, LineComment, Role, RunFile, StartRunInput } from './types.js';
import { DEFAULT_AGENTS } from './types.js';

/** После перезапуска приложения: прогоны, оборванные посреди стадии, помечаются остановленными. */
export async function recover(h: Kernel): Promise<void> {
  for (const s of h.store.list()) {
    // Агенты и тесты, пережившие аварийный выход приложения, не должны писать в worktree параллельно с повтором стадии.
    const orphans = [...h.store.readPids(s.id), ...h.store.readPids(`${s.id}:server`), ...h.store.readPids(`${s.id}:preview`)];
    if (orphans.length) {
      await Promise.all(orphans.map(killPid));
      h.store.writePids(s.id, []);
      h.store.writePids(`${s.id}:server`, []);
      h.store.writePids(`${s.id}:preview`, []);
    }
    if (s.status !== 'running' || s.missing) continue;
    const r = h.store.load(s.id);
    if (!r) continue;
    if (r.baseProbeStash) {
      // Приложение закрылось во время проверки тестов на исходном коде — возвращаем изменения прогона из stash.
      const sha = r.baseProbeStash;
      await h
        .tools(['git'])
        .then((t) => new Git(t.git, h.opts.env).restoreStash(r.worktreePath, sha))
        .then(() => {
          r.baseProbeStash = undefined;
        })
        .catch(() => {
          r.message = `Изменения прогона остались в git stash (${sha.slice(0, 8)}) — верните их: git stash apply ${sha.slice(0, 8)}`;
        });
    }
    for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
    // Оборванная реализация — не вина исполнителя: попытку возвращаем.
    if (r.next === 'implement' && r.implAttemptsUsed > 0) r.implAttemptsUsed--;
    // Исполнитель продолжит свою сессию: говорим ему, что прошлая попытка оборвалась, а не «исправь замечания».
    if (r.next === 'implement' && !r.feedback && r.executorSession) {
      r.feedback = {
        source: 'system',
        text: 'Прошлая попытка оборвалась на середине: приложение PurpleFlow было закрыто. Продолжи с того места, где остановился: посмотри, что уже сделано (git status, отметки в tasks.md), и доделай задачу.',
      };
    }
    if (r.message?.startsWith('Изменения прогона остались в git stash')) {
      r.status = 'stopped';
    } else {
      // Прогон продолжится сам — в очереди, с учётом лимита одновременных прогонов.
      r.status = 'queued';
      r.message = 'Приложение было закрыто — прогон продолжится сам с текущей стадии.';
    }
    h.store.save(r);
  }
  void pump(h);
}

export async function start(h: Kernel, input: StartRunInput): Promise<string> {
  const s = h.opts.getSettings();
  // Нужны только агенты, выбранные для ролей: на машине может стоять один claude или один codex.
  const roles: Record<Role, AgentKind> = {
    planner: s.agents?.planner ?? DEFAULT_AGENTS.planner,
    executor: s.agents?.executor ?? DEFAULT_AGENTS.executor,
    reviewer: s.agents?.reviewer ?? DEFAULT_AGENTS.reviewer,
  };
  const visualAgent = s.agents?.visual ?? 'claude';
  const tools = await h.tools(['git', 'openspec', ...new Set(Object.values(roles))]);
  const git = new Git(tools.git, h.opts.env);
  if (!input.task.trim()) throw new Error('Опишите задачу');
  if (!(await git.isRepo(input.projectPath))) throw new Error('Выбранная папка не является git-репозиторием');
  const repo = await git.topLevel(input.projectPath);
  const head = await git.head(repo).catch(() => {
    throw new Error('В репозитории нет ни одного коммита — сделайте первый коммит');
  });
  // Ветка, от которой начать: выбранная в окне (в неё можно ещё не переходить) или текущая.
  const baseBranch = input.baseBranch?.trim() || (await git.currentBranch(repo)) || undefined;
  const base = input.baseBranch?.trim()
    ? await git.revParse(repo, input.baseBranch.trim()).catch(() => {
        throw new Error(`Ветка ${input.baseBranch} не найдена`);
      })
    : head;

  const changeId = makeChangeId(input.task);
  const branch = runBranch(changeId);
  const workspace = input.workspace ?? 'worktree';
  if (workspace === 'branch') {
    // В режиме «ветка» прогон занимает рабочую копию проекта целиком — второй в том же проекте ей бы помешал.
    const busy = runsWithFiles(h).find(
      (r) =>
        r.workspace === 'branch' &&
        path.resolve(r.projectPath) === path.resolve(repo) &&
        ['running', 'waiting', 'queued'].includes(r.status),
    );
    if (busy)
      throw new Error(`В режиме «Ветка» в проекте уже идёт «${busy.title}». Дождитесь его или выберите отдельную копию (worktree).`);
  }
  const worktreePath = workspace === 'branch' ? repo : path.join(h.store.worktreesDir(), `${path.basename(repo)}-${changeId}`);
  const mode = input.mode ?? 'task';
  // Агента визуальной проверки на машине может не быть — тогда проверка выключается, а не роняет прогон.
  const visual = Boolean(input.visual && input.runCommand?.trim() && input.appUrl?.trim() && (await h.hasTool(visualAgent)));
  const queued = activeCount(h) >= maxParallel(h);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const carried = (input.attachmentPaths ?? [])
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ name: path.basename(p).replace(/^\d+-/, ''), data: fs.readFileSync(p) }));
  const attachments = saveAttachments(h, id, [...carried, ...(input.attachments ?? [])]);
  const run: RunFile = {
    version: RUN_VERSION,
    id,
    changeId,
    title: makeTitle(input.task),
    task: input.task.trim(),
    projectPath: repo,
    worktreePath,
    branch,
    baseCommit: base,
    baseBranch,
    testCommand: input.testCommand.trim(),
    setupCommand: input.setupCommand?.trim() || undefined,
    lintCommand: input.lintCommand?.trim() || undefined,
    mode,
    workspace,
    workspacePending: true,
    visual: visual || undefined,
    autopilot: input.autopilot || undefined,
    // Команда запуска нужна и визуальной стадии, и ручной проверке во вкладке «Браузер».
    runCommand: input.runCommand?.trim() || undefined,
    appUrl: input.appUrl?.trim() || undefined,
    visualNotes: input.visualNotes?.trim() || undefined,
    envFiles: input.envFiles?.map((f) => f.trim()).filter(Boolean),
    // В режиме «ветка» зависимости — уже установленные пользователем; подготовку не запускаем.
    prepared: workspace === 'branch' || !input.setupCommand?.trim(),
    models: { ...s.models },
    agents: { ...roles, ...(s.agents?.visual ? { visual: s.agents.visual } : {}) },
    status: queued ? 'queued' : 'running',
    next: MODE_FIRST[mode],
    attempts: [],
    planRetries: 0,
    implAttemptsUsed: 0,
    implAttemptsLimit: MODE_LIMIT[mode] ?? IMPL_LIMIT,
    tests: [],
    reviews: [],
    gates: [],
    totals: emptyUsage(),
    attachments: attachments.length ? attachments : undefined,
    createdAt: now,
    updatedAt: now,
  };
  if (queued) {
    h.save(run);
    h.log(
      run,
      c.dim(
        `PurpleFlow · ${run.changeId}\nв очереди: одновременно идут ${activeCount(h)} из ${maxParallel(h)} — начнётся, когда освободится место\n`,
      ),
    );
    return run.id;
  }
  try {
    await prepareWorkspace(h, run);
  } catch (e) {
    // Рабочую копию создать не удалось (грязная копия, ветка уже есть…) — прогона нет, ошибка уходит в окно.
    h.store.forget(run.id);
    throw e;
  }
  void drive(h, run);
  return run.id;
}

export function maxParallel(h: Kernel): number {
  return Math.max(1, Math.min(8, h.opts.getSettings().maxParallel ?? 2));
}

/** Прогоны, в которых сейчас работают агенты. Ожидание решения человека место не занимает. */
export function activeCount(h: Kernel): number {
  return h.store.list().filter((r) => r.status === 'running').length;
}

/** Запустить из очереди столько прогонов, сколько есть свободных мест (старые — первыми). */
export async function pump(h: Kernel) {
  if (h.pumping) return;
  h.pumping = true;
  try {
    while (activeCount(h) < maxParallel(h)) {
      const next = h.store
        .list()
        .filter((r) => r.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) break;
      const run = h.store.load(next.id);
      if (!run) break;
      await launchQueued(h, run);
    }
  } finally {
    h.pumping = false;
  }
}

export async function launchQueued(h: Kernel, run: RunFile) {
  run.status = 'running';
  run.message = undefined;
  h.save(run);
  try {
    if (run.workspacePending) await prepareWorkspace(h, run);
    // Продолжение после перезапуска приложения: в режиме «ветка» проект могли переключить на другую ветку.
    else await ensureOnBranch(h, run);
  } catch (e) {
    run.status = 'stopped';
    run.message = `Не удалось начать прогон: ${(e as Error).message}`;
    h.save(run);
    h.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message: run.message });
    return;
  }
  void drive(h, run);
}

export async function resume(h: Kernel, id: string) {
  if (h.driving.has(id)) return;
  const r = h.mustLoad(id);
  if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
  // Из очереди или не начавшийся — «Запустить сейчас», без оглядки на лимит одновременных прогонов.
  if (r.status === 'queued' || r.workspacePending) return launchQueued(h, r);
  await ensureOnBranch(h, r);
  r.message = undefined;
  if (r.next === 'plan') r.planRetries = 0;
  if (isGate(r.next)) return waitGate(h, r, r.next as GateId, gateMessage(h, r));
  r.status = 'running';
  h.save(r);
  void drive(h, r);
}

export async function stop(h: Kernel, id: string) {
  const r = h.store.load(id);
  if (!r) return;
  if (r.status === 'queued') {
    r.status = 'stopped';
    r.message = 'Снят с очереди. «Продолжить» запустит его сразу.';
    h.save(r);
    h.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message });
    return;
  }
  // Фоновые исходные проверки гибнут вместе с группой процессов — их итог больше не годится в эталон.
  h.basePrep.delete(id);
  await killGroup(`${id}:server`);
  await stopPreview(h, id);
  if (h.driving.has(id)) {
    h.stopping.add(id);
    await killGroup(id);
    return; // цикл drive сам зафиксирует остановку
  }
  await killGroup(id);
  if (r.status === 'running' || r.status === 'waiting') {
    for (const a of r.attempts)
      if (a.stage === 'baseline' && a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
    r.status = 'stopped';
    r.message = 'Остановлено пользователем';
    h.save(r);
    h.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message });
  }
}

/** Остановить крутящийся цикл стадий и дождаться, пока он отпустит прогон, — перед тем как самим поменять маршрут. */
export async function halt(h: Kernel, id: string) {
  if (!h.driving.has(id)) return;
  await stop(h, id);
  for (let i = 0; i < 100 && h.driving.has(id); i++) await new Promise((r) => setTimeout(r, 200));
  if (h.driving.has(id)) throw new Error('Не удалось остановить текущую стадию');
}

/** Повторить визуальную проверку: команда запуска и URL берутся из настроек проекта — их могли поправить. */
export async function rerunVisual(h: Kernel, id: string) {
  if (h.driving.has(id)) throw new Error('Прогон сейчас работает — дождитесь решения или остановите его');
  const r = h.mustLoad(id);
  if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
  if (!r.attempts.some((a) => a.stage === 'implement' && a.status === 'done')) throw new Error('Реализации ещё не было — проверять нечего');
  const cfg = getProjectConfig(h, r.projectPath);
  const runCommand = cfg?.runCommand?.trim() || r.runCommand;
  const appUrl = cfg?.appUrl?.trim() || r.appUrl;
  if (!runCommand || !appUrl) throw new Error('Нет команды запуска и адреса приложения — задайте их в настройках проекта');
  await stopPreview(h, id);
  await ensureOnBranch(h, r);
  r.runCommand = runCommand;
  r.appUrl = appUrl;
  r.visual = true;
  const now = new Date().toISOString();
  for (const a of r.attempts)
    if (a.status === 'running') Object.assign(a, { status: 'done', endedAt: now, summary: a.summary ?? 'Перезапуск визуальной проверки' });
  h.log(r, c.violet('↻ визуальная проверка заново') + '\n');
  r.message = undefined;
  r.next = 'visual';
  r.status = 'running';
  h.save(r);
  void drive(h, r);
}

/** Человек решил не ждать: текущая реализация или проверки останавливаются, проверки считаются пропущенными. */
export async function skipChecks(h: Kernel, id: string) {
  const before = h.mustLoad(id);
  if (before.next !== 'implement' && before.next !== 'tests' && before.next !== 'limit')
    throw new Error('Пропустить проверки можно только на реализации или проверках');
  if (!before.attempts.some((a) => a.stage === 'implement' && a.status === 'done'))
    throw new Error('Реализация ещё ни разу не завершилась — проверять нечего');
  await halt(h, id);
  const r = h.mustLoad(id);
  const now = new Date().toISOString();
  for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: now });
  const n = r.attempts.filter((a) => a.stage === 'tests').length + 1;
  r.attempts.push({ stage: 'tests', attempt: n, startedAt: now, endedAt: now, status: 'done', summary: 'Пропущены человеком' });
  r.tests.push({ at: now, command: '', passed: true, exitCode: 0, durationMs: 0, output: 'Проверки пропущены человеком.', checks: [] });
  h.log(r, c.amber('↷ проверки пропущены человеком — дальше ревью') + '\n');
  r.feedback = undefined;
  r.message = undefined;
  r.mergeOnly = undefined;
  r.next = afterChecks(r, await needsReview(h, r));
  r.status = 'running';
  h.save(r);
  void drive(h, r);
}

export async function decide(
  h: Kernel,
  id: string,
  decision: 'approve' | 'reject' | 'cancel' | 'accept' | 'fix',
  comment?: string,
  lineComments?: LineComment[],
) {
  const r = h.mustLoad(id);
  // Решение принято — сервер ручной проверки гасим: дальше коммит или новая попытка в той же рабочей копии.
  await stopPreview(h, id);
  if (!isGate(r.next) || (r.status !== 'waiting' && r.status !== 'stopped')) throw new Error('Прогон не ждёт решения на гейте');
  const gate = r.next as GateId;
  r.gates.push({
    gate,
    at: new Date().toISOString(),
    decision,
    comment: comment?.trim() || undefined,
    lineComments: lineComments?.length ? lineComments : undefined,
  });
  const gateAttempt = [...r.attempts].reverse().find((a) => a.stage === gate && a.status === 'running');
  if (gateAttempt) {
    gateAttempt.status = 'done';
    gateAttempt.endedAt = new Date().toISOString();
    gateAttempt.summary = decision === 'approve' ? 'Принято' : decision === 'reject' ? 'Возвращено' : 'Отменено';
  }
  r.message = undefined;
  const human = (text: string): Feedback => ({ source: 'human', text, lineComments: lineComments?.length ? lineComments : undefined });

  if (decision === 'fix') {
    if (gate !== 'gate2') throw new Error('Быстрая правка — только на приёмке');
    if (!comment?.trim() && !lineComments?.length) throw new Error('Опишите, что поправить');
    if (gateAttempt) gateAttempt.summary = 'Быстрая правка';
    r.quickFix = true;
    r.next = 'implement';
    r.implAttemptsLimit = Math.max(r.implAttemptsLimit, r.implAttemptsUsed + 1);
    r.feedback = {
      source: 'human',
      text: `Человек на приёмке просит небольшую правку. Сделай ровно это и ничего больше — остальная реализация уже принята, не переделывай её:\n${comment ?? ''}`,
      lineComments: lineComments?.length ? lineComments : undefined,
    };
    h.log(r, c.violet('→ быстрая правка с приёмки: реализация → проверки → снова приёмка') + '\n');
    r.status = 'running';
    h.save(r);
    void drive(h, r);
    return;
  }

  if (decision === 'accept') {
    if (gate !== 'limit') throw new Error('Принять как есть можно только после исчерпания попыток');
    // Человек берёт ответственность на себя: красные проверки или замечания ревью — дальше без новых попыток.
    // Визуальная проверка ещё не было — идём в неё (скриншоты пригодятся на приёмке), иначе — сразу на приёмку.
    const toVisual = acceptTarget(r) === 'visual';
    if (gateAttempt) gateAttempt.summary = toVisual ? 'Дальше как есть — к визуальной проверке' : 'Принято как есть';
    h.log(r, c.amber(`→ человек принял результат как есть — ${toVisual ? 'к визуальной проверке' : 'к приёмке'}`) + '\n');
    r.feedback = undefined;
    r.next = toVisual ? 'visual' : 'gate2';
    r.status = 'running';
    h.save(r);
    void drive(h, r);
    return;
  }

  if (decision === 'cancel') {
    if (gate === 'limit') {
      r.status = 'stopped';
      r.message = 'Остановлено после исчерпания попыток';
    } else {
      r.status = 'cancelled';
      r.finishedAt = new Date().toISOString();
    }
    h.save(r);
    h.emit({ type: 'run.finished', runId: id, status: r.status, message: r.message });
    return;
  }

  if (gate === 'gate0') {
    // «Принять» без ответов — продолжить по задаче как есть.
    if (r.clarify) r.clarify.skipped = true;
    r.next = 'plan';
  } else if (gate === 'gate1') {
    if (decision === 'approve') {
      r.next = 'implement';
      // План обновлён после возврата с реализации — исполнитель должен узнать, что и почему поменялось.
      r.feedback = r.replanNote
        ? human(
            `План обновлён: человек вернул задачу на план с реализации — «${r.replanNote}». Сверься с обновлённым proposal и tasks.md и продолжай по ним; то, что новому плану противоречит, переделай.`,
          )
        : undefined;
      r.replanNote = undefined;
      if (r.mode === 'epic') r.phase = 1;
    } else {
      r.next = 'plan';
      r.planRetries = 0;
      r.feedback = human(`Человек вернул план на доработку:\n${comment ?? ''}`);
    }
  } else if (gate === 'gate2') {
    if (decision === 'approve') {
      r.next = 'finish';
      r.feedback = undefined;
    } else {
      r.next = 'implement';
      r.implAttemptsLimit = Math.max(r.implAttemptsLimit, r.implAttemptsUsed + 1);
      r.feedback = human(`Человек вернул реализацию на приёмке:\n${comment ?? ''}`);
    }
  } else {
    // limit: «Ещё попытка» — даём одну попытку, сохраняя последнюю обратную связь.
    r.next = 'implement';
    r.implAttemptsLimit = r.implAttemptsUsed + 1;
    const prev = r.feedback?.text ?? '';
    r.feedback = {
      source: r.feedback?.source ?? 'human',
      text: [prev, comment?.trim() ? `Комментарий человека:\n${comment.trim()}` : ''].filter(Boolean).join('\n\n'),
      lineComments,
    };
  }
  r.status = 'running';
  h.save(r);
  void drive(h, r);
}

export async function drive(h: Kernel, run: RunFile) {
  if (h.driving.has(run.id)) return;
  h.driving.add(run.id);
  h.stopping.delete(run.id);
  // Продолжение старого прогона: файлов окружения в worktree могло ещё не быть.
  copyEnvFiles(h, run);
  try {
    while (run.status === 'running') {
      if (isGate(run.next)) {
        waitGate(h, run, run.next as GateId, gateMessage(h, run));
        break;
      }
      if (applyPending(h, run)) break;
      switch (run.next) {
        case 'baseline':
          await stageBaseline(h, run);
          break;
        case 'visual':
          await stageVisual(h, run);
          break;
        case 'clarify':
          await stageClarify(h, run);
          break;
        case 'plan':
          await stagePlan(h, run);
          break;
        case 'implement':
          await stageImplement(h, run);
          break;
        case 'tests':
          await stageTests(h, run);
          break;
        case 'review':
          await stageReview(h, run);
          break;
        case 'finish':
          await stageFinish(h, run);
          break;
      }
    }
  } catch (e) {
    if (e instanceof StopSignal || h.stopping.has(run.id)) {
      h.markStopped(run, 'Остановлено пользователем');
    } else {
      h.fail(run, (e as Error).message || String(e));
    }
  } finally {
    h.driving.delete(run.id);
    h.stopping.delete(run.id);
    // Место освободилось (гейт, конец, ошибка) — следующий из очереди.
    void pump(h);
  }
}

export function gateMessage(h: Kernel, run: RunFile): string | undefined {
  if (run.next === 'gate0')
    return `У планировщика ${run.clarify?.questions.length ?? 0} ${(run.clarify?.questions.length ?? 0) === 1 ? 'вопрос' : 'вопроса'} по задаче — ответьте, чтобы план не строился на догадках.`;
  if (run.next === 'limit') return run.message ?? 'Попытки реализации исчерпаны. Дать ещё одну попытку?';
  if (run.next === 'gate1' && run.mode === 'bug') return 'Баг воспроизведён падающим тестом. Причина и план исправления верны?';
  if (run.next === 'gate1' && run.mode === 'epic') return 'Проверьте design.md, этапы в tasks.md и proposal. Принять дизайн?';
  if (run.next === 'gate1' && run.nextParts)
    return 'Задача большая — планировщик взял в этот план первую часть, остальные перечислены в разделе «Next Parts» в proposal. Запустите их следующими задачами после этой. Принять план первой части?';
  if (run.next === 'gate1') return 'Проверьте proposal и tasks. Принять, вернуть с комментарием или отменить?';
  if (run.next === 'gate2') return 'Посмотрите дифф и замечания ревью. Принять или вернуть на доработку?';
  return undefined;
}

export function waitGate(h: Kernel, run: RunFile, gate: GateId, message?: string) {
  const open = run.attempts.find((a) => a.stage === gate && a.status === 'running');
  if (!open) h.begin(run, gate);
  // Гейт сам по себе пауза: отложенная пауза здесь исполнена, после решения прогон пойдёт дальше.
  if (run.pending?.some((p) => p.kind === 'pause')) {
    const at = new Set(run.pending.filter((p) => p.kind === 'pause').map((p) => p.at));
    for (const i of run.interventions ?? []) if (at.has(i.at)) i.appliedAt ??= new Date().toISOString();
    run.pending = run.pending.filter((p) => p.kind !== 'pause');
    if (!run.pending.length) run.pending = undefined;
  }
  run.status = 'waiting';
  run.next = gate;
  run.message = message;
  h.save(run);
  h.log(run, c.amber(`◆ ${STAGE_TITLES[gate]}: ждём решения человека`) + '\n');
  h.emit({ type: 'gate.waiting', runId: run.id, gate, message });
  if (gate === 'gate2') {
    void summarizeChanges(h, run.id).catch(() => undefined);
    void mapFilesToPlan(h, run.id).catch(() => undefined);
  }
  if (run.autopilot) void autopilotGate(h, run, gate);
}

/**
 * Автопилот: план без вопросов к человеку принимается сам, при исчерпанных попытках — одна попытка сама.
 * Вопросы уточнения, разбивка задачи на части и приёмка — всегда за человеком.
 */
export async function autopilotGate(h: Kernel, run: RunFile, gate: GateId) {
  if (gate === 'gate1') {
    if (run.replanNote) {
      h.log(run, c.amber('Автопилот: план переписан после возврата с реализации — проверьте его сами.') + '\n');
      return;
    }
    const docs = await getChangeDocs(h, run.id).catch(() => null);
    if (docs && /^##\s+Next Parts/m.test(docs.proposal)) {
      h.log(run, c.amber('Автопилот: планировщик предлагает разбить задачу на части — план ждёт вашего решения.') + '\n');
      return;
    }
    h.log(run, c.violet('Автопилот: план принят без остановки.') + '\n');
    await new Promise((r) => setTimeout(r, 800));
    await decide(h, run.id, 'approve', 'Автопилот').catch((e) =>
      h.warn(h.mustLoad(run.id), `Автопилот не смог принять план — примите его сами: ${(e as Error).message}`),
    );
    return;
  }
  if (gate === 'limit' && !run.autoRetried) {
    const r = h.mustLoad(run.id);
    r.autoRetried = true;
    h.save(r);
    h.log(run, c.violet('Автопилот: попытки исчерпаны — даю ещё одну сам; следующий раз решите вы.') + '\n');
    await new Promise((res) => setTimeout(res, 800));
    await decide(h, run.id, 'approve').catch((e) =>
      h.warn(h.mustLoad(run.id), `Автопилот не смог дать ещё одну попытку: ${(e as Error).message}`),
    );
  }
}

/**
 * Удалить прогон. Сначала гасим всё живое (агент, сервер, предпросмотр), потом worktree,
 * по желанию — ветку, и данные в каталоге приложения. Рабочая копия проекта в режиме «ветка» не трогается.
 */
export async function deleteRun(h: Kernel, id: string, deleteBranch: boolean) {
  const r = h.store.load(id);
  const tools = await h.tools(['git']);
  const git = new Git(tools.git, h.opts.env);
  // Проверяем до удаления чего-либо: открытую в проекте ветку git не удалит.
  if (r && deleteBranch) {
    const cur = await git.currentBranch(r.projectPath).catch(() => null);
    if (cur === r.branch)
      throw new Error(
        `Проект сейчас на ветке ${r.branch} — переключитесь на другую (git checkout ${r.originalBranch ?? 'main'}), чтобы удалить её, или удалите прогон без ветки.`,
      );
  }
  if (h.driving.has(id)) {
    h.stopping.add(id);
    await killGroup(id);
    // drive сам выйдет из цикла; ждём, пока отпустит прогон.
    for (let i = 0; i < 100 && h.driving.has(id); i++) await new Promise((res) => setTimeout(res, 100));
  }
  await killGroup(id);
  await killGroup(`${id}:server`);
  await killGroup(`${id}:manager`);
  await stopPreview(h, id);
  if (r) {
    if (r.workspace !== 'branch' && fs.existsSync(r.worktreePath))
      await git.removeWorktree(r.projectPath, r.worktreePath).catch(() => undefined);
    if (deleteBranch) await git.deleteBranch(r.projectPath, r.branch).catch(() => undefined);
  }
  for (const dir of [attachmentsDir(h, id), path.join(h.opts.dataDir, 'visual', id)]) fs.rmSync(dir, { recursive: true, force: true });
  h.store.forget(id);
  h.emit({ type: 'run.deleted', runId: id });
  void pump(h);
}
