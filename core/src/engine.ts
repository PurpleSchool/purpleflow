// Движок прогона: цикл стадий, очередь, старт, остановка и восстановление. Гейты и решения человека — в gates.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { c, emptyUsage } from './agents/common.js';
import { gateMessage, waitGate } from './gates.js';
import { Git } from './git.js';
import { makeChangeId, makeTitle, runBranch } from './ids.js';
import type { Kernel } from './kernel.js';
import { RUN_VERSION } from './migrate.js';
import { MODE_FIRST, MODE_LIMIT } from './modes.js';
import { killGroup, killPid } from './proc.js';
import { afterChecks } from './route.js';
import { IMPL_LIMIT, StopSignal } from './runtime.js';
import { attachmentsDir, saveAttachments } from './services/attachments.js';
import { applyPending } from './services/control.js';
import { stopPreview } from './services/preview.js';
import { getProjectConfig } from './services/projects.js';
import { runsWithFiles } from './services/runs.js';
import { copyEnvFiles, ensureOnBranch, prepareWorkspace } from './services/workspace.js';
import { isGate } from './stage-info.js';
import { needsReview, stageBaseline, stageTests } from './stages/checks.js';
import { stageFinish } from './stages/finish.js';
import { stageImplement } from './stages/implement.js';
import { stageClarify, stagePlan } from './stages/plan.js';
import { stageReview } from './stages/review.js';
import { stageVisual } from './stages/visual.js';
import { traced } from './trace.js';
import type { AgentKind, GateId, Role, RunFile, StartRunInput } from './types.js';
import { DEFAULT_AGENTS } from './types.js';

/** После перезапуска приложения: прогоны, оборванные посреди стадии, помечаются остановленными. */
export async function recover(k: Kernel): Promise<void> {
  for (const s of k.store.list()) {
    // Агенты и тесты, пережившие аварийный выход приложения, не должны писать в worktree параллельно с повтором стадии.
    const orphans = [...k.store.readPids(s.id), ...k.store.readPids(`${s.id}:server`), ...k.store.readPids(`${s.id}:preview`)];
    if (orphans.length) {
      await Promise.all(orphans.map(killPid));
      k.store.writePids(s.id, []);
      k.store.writePids(`${s.id}:server`, []);
      k.store.writePids(`${s.id}:preview`, []);
    }
    if (s.status !== 'running' || s.missing) continue;
    const r = k.store.load(s.id);
    if (!r) continue;
    if (r.baseProbeStash) {
      // Приложение закрылось во время проверки тестов на исходном коде — возвращаем изменения прогона из stash.
      const sha = r.baseProbeStash;
      await k
        .tools(['git'])
        .then((t) => new Git(t.git, k.opts.env).restoreStash(r.worktreePath, sha))
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
    k.store.save(r);
  }
  void pump(k);
}

export async function start(k: Kernel, input: StartRunInput): Promise<string> {
  const s = k.opts.getSettings();
  // Нужны только агенты, выбранные для ролей: на машине может стоять один claude или один codex.
  const roles: Record<Role, AgentKind> = {
    planner: s.agents?.planner ?? DEFAULT_AGENTS.planner,
    executor: s.agents?.executor ?? DEFAULT_AGENTS.executor,
    reviewer: s.agents?.reviewer ?? DEFAULT_AGENTS.reviewer,
  };
  const visualAgent = s.agents?.visual ?? 'claude';
  const tools = await k.tools(['git', 'openspec', ...new Set(Object.values(roles))]);
  const git = new Git(tools.git, k.opts.env);
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
    const busy = runsWithFiles(k).find(
      (r) =>
        r.workspace === 'branch' &&
        path.resolve(r.projectPath) === path.resolve(repo) &&
        ['running', 'waiting', 'queued'].includes(r.status),
    );
    if (busy)
      throw new Error(`В режиме «Ветка» в проекте уже идёт «${busy.title}». Дождитесь его или выберите отдельную копию (worktree).`);
  }
  const worktreePath = workspace === 'branch' ? repo : path.join(k.store.worktreesDir(), `${path.basename(repo)}-${changeId}`);
  const mode = input.mode ?? 'task';
  // Агента визуальной проверки на машине может не быть — тогда проверка выключается, а не роняет прогон.
  const visual = Boolean(input.visual && input.runCommand?.trim() && input.appUrl?.trim() && (await k.hasTool(visualAgent)));
  const queued = activeCount(k) >= maxParallel(k);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const carried = (input.attachmentPaths ?? [])
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ name: path.basename(p).replace(/^\d+-/, ''), data: fs.readFileSync(p) }));
  const attachments = saveAttachments(k, id, [...carried, ...(input.attachments ?? [])]);
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
    k.save(run);
    k.log(
      run,
      c.dim(
        `PurpleFlow · ${run.changeId}\nв очереди: одновременно идут ${activeCount(k)} из ${maxParallel(k)} — начнётся, когда освободится место\n`,
      ),
    );
    return run.id;
  }
  try {
    await prepareWorkspace(k, run);
  } catch (e) {
    // Рабочую копию создать не удалось (грязная копия, ветка уже есть…) — прогона нет, ошибка уходит в окно.
    k.store.forget(run.id);
    throw e;
  }
  void drive(k, run);
  return run.id;
}

export function maxParallel(k: Kernel): number {
  return Math.max(1, Math.min(8, k.opts.getSettings().maxParallel ?? 2));
}

/** Прогоны, в которых сейчас работают агенты. Ожидание решения человека место не занимает. */
export function activeCount(k: Kernel): number {
  return k.store.list().filter((r) => r.status === 'running').length;
}

/** Запустить из очереди столько прогонов, сколько есть свободных мест (старые — первыми). */
export async function pump(k: Kernel) {
  if (k.pumping) return;
  k.pumping = true;
  try {
    while (activeCount(k) < maxParallel(k)) {
      const next = k.store
        .list()
        .filter((r) => r.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) break;
      const run = k.store.load(next.id);
      if (!run) break;
      await launchQueued(k, run);
    }
  } finally {
    k.pumping = false;
  }
}

export async function launchQueued(k: Kernel, run: RunFile) {
  run.status = 'running';
  run.message = undefined;
  k.save(run);
  try {
    if (run.workspacePending) await prepareWorkspace(k, run);
    // Продолжение после перезапуска приложения: в режиме «ветка» проект могли переключить на другую ветку.
    else await ensureOnBranch(k, run);
  } catch (e) {
    run.status = 'stopped';
    run.message = `Не удалось начать прогон: ${(e as Error).message}`;
    k.save(run);
    k.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message: run.message });
    return;
  }
  void drive(k, run);
}

export async function resume(k: Kernel, id: string) {
  if (k.driving.has(id)) return;
  const r = k.mustLoad(id);
  if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
  // Из очереди или не начавшийся — «Запустить сейчас», без оглядки на лимит одновременных прогонов.
  if (r.status === 'queued' || r.workspacePending) return launchQueued(k, r);
  await ensureOnBranch(k, r);
  r.message = undefined;
  if (r.next === 'plan') r.planRetries = 0;
  if (isGate(r.next)) return waitGate(k, r, r.next as GateId, gateMessage(k, r));
  r.status = 'running';
  k.save(r);
  void drive(k, r);
}

export async function stop(k: Kernel, id: string) {
  const r = k.store.load(id);
  if (!r) return;
  if (r.status === 'queued') {
    r.status = 'stopped';
    r.message = 'Снят с очереди. «Продолжить» запустит его сразу.';
    k.save(r);
    k.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message });
    return;
  }
  // Фоновые исходные проверки гибнут вместе с группой процессов — их итог больше не годится в эталон.
  k.basePrep.delete(id);
  await killGroup(`${id}:server`);
  await stopPreview(k, id);
  if (k.driving.has(id)) {
    k.stopping.add(id);
    await killGroup(id);
    return; // цикл drive сам зафиксирует остановку
  }
  await killGroup(id);
  if (r.status === 'running' || r.status === 'waiting') {
    for (const a of r.attempts)
      if (a.stage === 'baseline' && a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
    r.status = 'stopped';
    r.message = 'Остановлено пользователем';
    k.save(r);
    k.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message });
  }
}

/** Остановить крутящийся цикл стадий и дождаться, пока он отпустит прогон, — перед тем как самим поменять маршрут. */
export async function halt(k: Kernel, id: string) {
  if (!k.driving.has(id)) return;
  await stop(k, id);
  for (let i = 0; i < 100 && k.driving.has(id); i++) await new Promise((r) => setTimeout(r, 200));
  if (k.driving.has(id)) throw new Error('Не удалось остановить текущую стадию');
}

/** Повторить визуальную проверку: команда запуска и URL берутся из настроек проекта — их могли поправить. */
export async function rerunVisual(k: Kernel, id: string) {
  if (k.driving.has(id)) throw new Error('Прогон сейчас работает — дождитесь решения или остановите его');
  const r = k.mustLoad(id);
  if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
  if (!r.attempts.some((a) => a.stage === 'implement' && a.status === 'done')) throw new Error('Реализации ещё не было — проверять нечего');
  const cfg = getProjectConfig(k, r.projectPath);
  const runCommand = cfg?.runCommand?.trim() || r.runCommand;
  const appUrl = cfg?.appUrl?.trim() || r.appUrl;
  if (!runCommand || !appUrl) throw new Error('Нет команды запуска и адреса приложения — задайте их в настройках проекта');
  await stopPreview(k, id);
  await ensureOnBranch(k, r);
  r.runCommand = runCommand;
  r.appUrl = appUrl;
  r.visual = true;
  const now = new Date().toISOString();
  for (const a of r.attempts)
    if (a.status === 'running') Object.assign(a, { status: 'done', endedAt: now, summary: a.summary ?? 'Перезапуск визуальной проверки' });
  k.log(r, c.violet('↻ визуальная проверка заново') + '\n');
  r.message = undefined;
  r.next = 'visual';
  r.status = 'running';
  k.save(r);
  void drive(k, r);
}

/** Человек решил не ждать: текущая реализация или проверки останавливаются, проверки считаются пропущенными. */
export async function skipChecks(k: Kernel, id: string) {
  const before = k.mustLoad(id);
  if (before.next !== 'implement' && before.next !== 'tests' && before.next !== 'limit')
    throw new Error('Пропустить проверки можно только на реализации или проверках');
  if (!before.attempts.some((a) => a.stage === 'implement' && a.status === 'done'))
    throw new Error('Реализация ещё ни разу не завершилась — проверять нечего');
  await halt(k, id);
  const r = k.mustLoad(id);
  const now = new Date().toISOString();
  for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: now });
  const n = r.attempts.filter((a) => a.stage === 'tests').length + 1;
  r.attempts.push({ stage: 'tests', attempt: n, startedAt: now, endedAt: now, status: 'done', summary: 'Пропущены человеком' });
  r.tests.push({ at: now, command: '', passed: true, exitCode: 0, durationMs: 0, output: 'Проверки пропущены человеком.', checks: [] });
  k.log(r, c.amber('↷ проверки пропущены человеком — дальше ревью') + '\n');
  r.feedback = undefined;
  r.message = undefined;
  r.mergeOnly = undefined;
  r.next = afterChecks(r, await needsReview(k, r));
  r.status = 'running';
  k.save(r);
  void drive(k, r);
}

export async function drive(k: Kernel, run: RunFile) {
  if (k.driving.has(run.id)) return;
  k.driving.add(run.id);
  k.stopping.delete(run.id);
  // Продолжение старого прогона: файлов окружения в worktree могло ещё не быть.
  copyEnvFiles(k, run);
  try {
    while (run.status === 'running') {
      if (isGate(run.next)) {
        waitGate(k, run, run.next as GateId, gateMessage(k, run));
        break;
      }
      if (applyPending(k, run)) break;
      switch (run.next) {
        case 'baseline':
          await stageBaseline(k, run);
          break;
        case 'visual':
          await stageVisual(k, run);
          break;
        case 'clarify':
          await stageClarify(k, run);
          break;
        case 'plan':
          await stagePlan(k, run);
          break;
        case 'implement':
          await stageImplement(k, run);
          break;
        case 'tests':
          await stageTests(k, run);
          break;
        case 'review':
          await stageReview(k, run);
          break;
        case 'finish':
          await stageFinish(k, run);
          break;
      }
    }
  } catch (e) {
    if (e instanceof StopSignal || k.stopping.has(run.id)) {
      k.markStopped(run, 'Остановлено пользователем');
    } else {
      k.fail(run, (e as Error).message || String(e));
    }
  } finally {
    k.driving.delete(run.id);
    k.stopping.delete(run.id);
    // Место освободилось (гейт, конец, ошибка) — следующий из очереди.
    void pump(k);
  }
}

/**
 * Удалить прогон. Сначала гасим всё живое (агент, сервер, предпросмотр), потом worktree,
 * по желанию — ветку, и данные в каталоге приложения. Рабочая копия проекта в режиме «ветка» не трогается.
 */
export async function deleteRun(k: Kernel, id: string, deleteBranch: boolean) {
  const r = k.store.load(id);
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  // Проверяем до удаления чего-либо: открытую в проекте ветку git не удалит.
  if (r && deleteBranch) {
    const cur = await git.currentBranch(r.projectPath).catch(() => null);
    if (cur === r.branch)
      throw new Error(
        `Проект сейчас на ветке ${r.branch} — переключитесь на другую (git checkout ${r.originalBranch ?? 'main'}), чтобы удалить её, или удалите прогон без ветки.`,
      );
  }
  if (k.driving.has(id)) {
    k.stopping.add(id);
    await killGroup(id);
    // drive сам выйдет из цикла; ждём, пока отпустит прогон.
    for (let i = 0; i < 100 && k.driving.has(id); i++) await new Promise((res) => setTimeout(res, 100));
  }
  await killGroup(id);
  await killGroup(`${id}:server`);
  await killGroup(`${id}:manager`);
  await stopPreview(k, id);
  if (r) {
    if (r.workspace !== 'branch' && fs.existsSync(r.worktreePath))
      await git.removeWorktree(r.projectPath, r.worktreePath).catch(traced('deleteRun: worktree'));
    if (deleteBranch) await git.deleteBranch(r.projectPath, r.branch).catch(traced('deleteRun: branch'));
  }
  for (const dir of [attachmentsDir(k, id), path.join(k.opts.dataDir, 'visual', id)]) fs.rmSync(dir, { recursive: true, force: true });
  k.store.forget(id);
  k.emit({ type: 'run.deleted', runId: id });
  void pump(k);
}
