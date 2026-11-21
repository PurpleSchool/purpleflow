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
import { runProcessGroups } from './run-processes.js';
import { isInside } from './files.js';
import { afterChecks } from './route.js';
import { IMPL_LIMIT, StopSignal } from './runtime.js';
import { attachmentsDir, saveAttachments } from './services/attachments.js';
import { applyPending } from './services/control.js';
import { stopPreview } from './services/preview.js';
import { getProjectConfig } from './services/projects.js';
import { removeRepoWorktrees, multiRepoOf } from './services/repos.js';
import { runsWithFiles } from './services/runs.js';
import { copyEnvFiles, ensureOnBranch, prepareWorkspace } from './services/workspace.js';
import { isGate } from './stage-info.js';
import { needsReview, stageBaseline, stageTests, startNextPhase } from './stages/checks.js';
import { stageFinish } from './stages/finish.js';
import { stageImplement } from './stages/implement.js';
import { stageClarify, stagePlan } from './stages/plan.js';
import { stageCodeReview } from './stages/codereview.js';
import { stageReview } from './stages/review.js';
import { stageVisual } from './stages/visual.js';
import { traced } from './trace.js';
import type { AgentKind, Efforts, GateId, ReviewTarget, Role, RunFile, StartRunInput } from './types.js';
import { DEFAULT_AGENTS, effortFor, enabledAgent } from './types.js';

/** После перезапуска приложения: прогоны, оборванные посреди стадии, помечаются остановленными. */
export async function recover(k: Kernel): Promise<void> {
  for (const s of k.store.list()) {
    // Агенты и тесты, пережившие аварийный выход приложения, не должны писать в worktree параллельно с повтором стадии.
    for (const group of runProcessGroups(s.id)) {
      const pids = k.store.readPids(group);
      if (!pids.length) continue;
      const recordedAt = k.store.pidsTime(group);
      await Promise.all(pids.map((pid) => killPid(pid, recordedAt)));
      k.store.writePids(group, []);
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
  // Выключенный в настройках CLI роль не выполняет: она переходит на включённый, с его моделью по умолчанию.
  const roles: Record<Role, AgentKind> = {
    planner: enabledAgent(s, s.agents?.planner ?? DEFAULT_AGENTS.planner),
    executor: enabledAgent(s, s.agents?.executor ?? DEFAULT_AGENTS.executor),
    reviewer: enabledAgent(s, s.agents?.reviewer ?? DEFAULT_AGENTS.reviewer),
  };
  const models = { ...s.models };
  for (const r of Object.keys(roles) as Role[]) if (roles[r] !== (s.agents?.[r] ?? DEFAULT_AGENTS[r])) models[r] = '';
  // Уровень рассуждений — только тот, что понимает агент роли (у роли, переехавшей на другой CLI, его может не быть).
  const efforts: Efforts = {};
  for (const r of Object.keys(roles) as Role[]) {
    const e = effortFor(roles[r], s.efforts?.[r]);
    if (e) efforts[r] = e;
  }
  const visualAgent = enabledAgent(s, s.agents?.visual ?? 'claude');
  if (visualAgent !== (s.agents?.visual ?? 'claude')) models.visual = '';
  const tools = await k.tools(['git', 'openspec', ...new Set(Object.values(roles))]);
  const git = new Git(tools.git, k.opts.env);
  const mode = input.mode ?? 'task';
  // В ревью кода текст задачи — только на чём сосредоточиться, его можно не писать.
  if (!input.task.trim() && mode !== 'review') throw new Error('Опишите задачу');
  if (!(await git.isRepo(input.projectPath))) throw new Error('Выбранная папка не является git-репозиторием');
  const repo = await git.topLevel(input.projectPath);
  // Подпапку чужого репозитория не подменяем молча его корнем: задача ушла бы в другой проект.
  if (await git.enclosingRoot(input.projectPath))
    throw new Error(
      `Папка ${input.projectPath} лежит внутри репозитория ${repo} — выберите корень репозитория или сделайте в папке git init`,
    );
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

  const review = mode === 'review' ? await resolveReview(git, repo, input.reviewTarget) : undefined;
  const reviewBranch = review?.target.kind === 'branch' ? review.target.branch : undefined;
  const changeId = makeChangeId(review ? `review ${review.label}` : input.task);
  const branch = runBranch(changeId);
  // Несколько репозиториев: у каждого своя рабочая копия на той же ветке, все — в общей папке прогона.
  // Ревью кода смотрит один репозиторий и всегда в отдельной копии: проект не переключается ни на какую ветку.
  const multi = review ? null : multiRepoOf(repo, (getProjectConfig(k, repo) ?? getProjectConfig(k, input.projectPath))?.multiRepo);
  const workspace = multi || review ? 'worktree' : (input.workspace ?? 'worktree');
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
  const rootDir = multi ? path.join(k.store.worktreesDir(), `${path.basename(multi.root)}-${changeId}`) : undefined;
  const worktreePath =
    workspace === 'branch'
      ? repo
      : multi
        ? path.join(rootDir!, multi.main)
        : path.join(k.store.worktreesDir(), `${path.basename(repo)}-${changeId}`);
  const repos = multi
    ? await Promise.all(
        multi.repos.map(async (rel) => {
          const at = path.join(multi.root, rel);
          const head = await git.head(at).catch(() => {
            throw new Error(`В репозитории ${rel} нет ни одного коммита — сделайте первый коммит или снимите его в настройках проекта`);
          });
          return {
            rel,
            path: at,
            worktreePath: path.join(rootDir!, rel),
            baseCommit: head,
            baseBranch: (await git.currentBranch(at).catch(() => null)) ?? undefined,
          };
        }),
      )
    : undefined;
  // Агента визуальной проверки на машине может не быть — тогда проверка выключается, а не роняет прогон.
  const visual = Boolean(!review && input.visual && input.runCommand?.trim() && input.appUrl?.trim() && (await k.hasTool(visualAgent)));
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
    title: makeTitle(review ? `Ревью: ${review.label}` : input.task),
    task: input.task.trim(),
    review: review ? { target: review.target, tip: review.tip, label: review.label } : undefined,
    projectPath: repo,
    worktreePath,
    root: multi ? { path: multi.root, dir: rootDir!, main: multi.main } : undefined,
    repos,
    branch,
    baseCommit: review?.base ?? base,
    baseBranch: reviewBranch ?? baseBranch,
    testCommand: input.testCommand.trim(),
    setupCommand: input.setupCommand?.trim() || undefined,
    lintCommand: input.lintCommand?.trim() || undefined,
    mode,
    workspace,
    workspacePending: true,
    visual: visual || undefined,
    autopilot: (!review && input.autopilot) || undefined,
    // Команда запуска нужна и визуальной стадии, и ручной проверке во вкладке «Браузер».
    runCommand: input.runCommand?.trim() || undefined,
    appUrl: input.appUrl?.trim() || undefined,
    visualNotes: input.visualNotes?.trim() || undefined,
    envFiles: input.envFiles?.map((f) => f.trim()).filter(Boolean),
    // В режиме «ветка» зависимости — уже установленные пользователем; подготовку не запускаем.
    prepared: Boolean(review) || workspace === 'branch' || !input.setupCommand?.trim(),
    models,
    ...(Object.keys(efforts).length ? { efforts } : {}),
    agents: { ...roles, ...(s.agents?.visual || visualAgent !== 'claude' ? { visual: visualAgent } : {}) },
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
  // Сразу на диск: лимит одновременных прогонов и занятость проекта считаются по списку, а подготовка идёт долго.
  k.save(run);
  k.preparing.add(run.id);
  try {
    await prepareWorkspace(k, run);
    if (k.stopping.delete(run.id)) {
      k.markStopped(run, 'Остановлено пользователем');
      return run.id;
    }
  } catch (e) {
    k.stopping.delete(run.id);
    // Рабочую копию создать не удалось (грязная копия, ветка уже есть…) — прогона нет, ошибка уходит в окно.
    k.store.forget(run.id);
    k.emit({ type: 'run.deleted', runId: run.id });
    throw e;
  } finally {
    k.preparing.delete(run.id);
  }
  void drive(k, run);
  return run.id;
}

/**
 * Что смотрит ревью кода: коммит, на котором будет рабочая копия (tip), и база диффа.
 * Незакоммиченные изменения — снимком поверх HEAD, файлы — как они есть в HEAD (дифф пустой, ревьюер читает файлы).
 */
export async function resolveReview(
  git: Git,
  repo: string,
  target: StartRunInput['reviewTarget'],
): Promise<{ target: ReviewTarget; tip: string; base: string; label: string }> {
  if (!target) throw new Error('Выберите, что проверить');
  const head = await git.head(repo);
  switch (target.kind) {
    case 'uncommitted': {
      if (!(await git.dirtyFiles(repo)).length) throw new Error('Незакоммиченных изменений нет — проверять нечего');
      const tip = await git.snapshotWorkingTree(repo, 'PurpleFlow: незакоммиченные изменения для ревью');
      return { target, tip, base: head, label: 'незакоммиченные изменения' };
    }
    case 'commit': {
      const tip = await git.revParse(repo, target.hash).catch(() => '');
      if (!tip) throw new Error(`Коммит ${target.hash} не найден`);
      const parent = await git.parentOf(repo, tip);
      if (!parent) throw new Error('Это первый коммит репозитория — выберите «Файлы», чтобы проверить код целиком');
      return { target: { kind: 'commit', hash: tip }, tip, base: parent, label: `коммит ${tip.slice(0, 7)}` };
    }
    case 'branch': {
      const tip = await git.revParse(repo, target.branch).catch(() => '');
      if (!tip) throw new Error(`Ветка ${target.branch} не найдена`);
      const against = await git.revParse(repo, target.against).catch(() => '');
      if (!against) throw new Error(`Ветка ${target.against} не найдена`);
      const base = await git.mergeBase(repo, against, tip);
      if (base === tip) throw new Error(`В ветке ${target.branch} нет своих коммитов относительно ${target.against}`);
      return { target, tip, base, label: `${target.branch} против ${target.against}` };
    }
    case 'files': {
      const files = [...new Set(target.files.map((f) => f.trim().replace(/^\.?\/+/, '')).filter(Boolean))];
      if (!files.length) throw new Error('Выберите файлы для ревью');
      const label = files.length === 1 ? files[0] : `${files[0]} и ещё ${files.length - 1}`;
      return { target: { kind: 'files', files }, tip: head, base: head, label };
    }
  }
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
  k.preparing.add(run.id);
  try {
    if (run.workspacePending) await prepareWorkspace(k, run);
    // Продолжение после перезапуска приложения: в режиме «ветка» проект могли переключить на другую ветку.
    else await ensureOnBranch(k, run);
    if (k.deleted.has(run.id)) return;
    if (k.stopping.delete(run.id)) return k.markStopped(run, 'Остановлено пользователем');
  } catch (e) {
    if (k.deleted.has(run.id)) return;
    if (k.stopping.delete(run.id)) return k.markStopped(run, 'Остановлено пользователем');
    run.status = 'stopped';
    run.message = `Не удалось начать прогон: ${(e as Error).message}`;
    k.save(run);
    k.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message: run.message, reason: 'start_failed' });
    return;
  } finally {
    k.preparing.delete(run.id);
  }
  void drive(k, run);
}

/** Проверка на исходном коде не смогла вернуть изменения прогона: без них продолжать нельзя — в коммит ушло бы пустое место. */
async function restoreProbeStash(k: Kernel, r: RunFile) {
  const sha = r.baseProbeStash!;
  const git = new Git((await k.tools(['git'])).git, k.opts.env);
  try {
    await git.restoreStash(r.worktreePath, sha);
  } catch (e) {
    throw new Error(
      `Изменения прогона лежат в git stash (${sha.slice(0, 8)}) и не возвращаются: ${(e as Error).message}\nУберите мешающие правки в рабочей копии и нажмите «Продолжить» снова.`,
      { cause: e },
    );
  }
  r.baseProbeStash = undefined;
  k.save(r);
}

export async function resume(k: Kernel, id: string) {
  if (k.driving.has(id)) return;
  const r = k.mustLoad(id);
  if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
  if (k.preparing.has(id)) return;
  if (r.baseProbeStash) await restoreProbeStash(k, r);
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

/**
 * Отменённый прогон — снова в работу: отмена бывает только на решении человека (уточнение, план, приёмка),
 * а рабочая копия с планом и кодом остаётся до очистки хранилища. Возвращаем на ту же стадию решения.
 */
export async function restore(k: Kernel, id: string) {
  const r = k.mustLoad(id);
  if (r.status !== 'cancelled') throw new Error('Восстановить можно только отменённый прогон');
  // Незакоммиченные план и код жили только в рабочей копии: удалена очисткой — возвращать нечего.
  if (r.workspace !== 'branch' && (r.worktreeRemoved || !fs.existsSync(r.worktreePath)))
    throw new Error('Рабочая копия прогона уже удалена при очистке хранилища — восстановить нельзя. Запустите задачу заново.');
  r.status = 'stopped';
  r.finishedAt = undefined;
  r.message = 'Восстановлен после отмены';
  k.log(r, c.violet('↺ прогон восстановлен после отмены') + '\n');
  k.save(r);
  k.emit({ type: 'run.updated', run: r });
  await resume(k, id);
}

export async function stop(k: Kernel, id: string) {
  const r = k.store.load(id);
  if (!r) return;
  k.beginBackgroundTeardown(id);
  k.cancelBackground(id);
  const active = k.driving.has(id) || k.preparing.has(id);
  const queued = r.status === 'queued';
  if (active) k.stopping.add(id);
  // Фоновые исходные проверки гибнут вместе с группой процессов — их итог больше не годится в эталон.
  k.basePrep.delete(id);
  if (queued) {
    r.status = 'stopped';
    r.message = 'Снят с очереди. «Продолжить» запустит его сразу.';
    k.save(r);
  }
  try {
    // Start every kill before awaiting any of them. The teardown guard prevents a new manager from joining these groups.
    const kills = runProcessGroups(id)
      .filter((group) => group !== `${id}:preview`)
      .map(killGroup);
    await Promise.all([...kills, stopPreview(k, id)]);
    if (k.deleted.has(id)) return;
    if (queued) {
      k.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message, reason: 'unqueued' });
      return;
    }
    if (active) return; // цикл drive (или launchQueued) сам зафиксирует остановку
    if (r.status === 'running' || r.status === 'waiting') {
      for (const a of r.attempts)
        if (a.stage === 'baseline' && a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
      r.status = 'stopped';
      r.message = 'Остановлено пользователем';
      k.save(r);
      k.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message, reason: 'user_stop' });
    }
  } finally {
    k.endBackgroundTeardown(id);
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
  // Большая задача: пропуск проверок этапа не должен терять остальные этапы.
  if (!startNextPhase(k, r)) {
    r.next = afterChecks(r, await needsReview(k, r));
    r.mergeOnly = undefined;
  }
  r.status = 'running';
  k.save(r);
  void drive(k, r);
}

export async function drive(k: Kernel, run: RunFile) {
  if (k.driving.has(run.id)) return;
  k.driving.add(run.id);
  k.live.set(run.id, run);
  k.stopping.delete(run.id);
  // Продолжение старого прогона: файлов окружения в worktree могло ещё не быть.
  copyEnvFiles(k, run);
  try {
    while (run.status === 'running') {
      // «Стоп» между стадиями убивать некого — иначе он потерялся бы, а следующая стадия пошла как ни в чём не бывало.
      k.checkStop(run);
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
          await (run.mode === 'review' ? stageCodeReview(k, run) : stageReview(k, run));
          break;
        case 'finish':
          await stageFinish(k, run);
          break;
      }
    }
  } catch (e) {
    if (k.deleted.has(run.id)) {
      // Delete owns the final event and data removal.
    } else if (e instanceof StopSignal || k.stopping.has(run.id)) {
      k.markStopped(run, 'Остановлено пользователем');
    } else {
      k.fail(run, (e as Error).message || String(e));
    }
  } finally {
    k.driving.delete(run.id);
    k.live.delete(run.id);
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
  k.deleted.add(id);
  k.cancelBackground(id);
  if (k.driving.has(id) || k.preparing.has(id)) k.stopping.add(id);
  if (k.driving.has(id) || k.preparing.has(id)) {
    await Promise.all(
      runProcessGroups(id)
        .filter((group) => group !== `${id}:preview`)
        .map(killGroup),
    );
    // drive сам выйдет из цикла; ждём, пока отпустит прогон.
    for (let i = 0; i < 100 && (k.driving.has(id) || k.preparing.has(id)); i++) await new Promise((res) => setTimeout(res, 100));
  }
  // Стадия могла не успеть выйти (её finally бывает долгим): её запоздалое сохранение не должно вернуть прогон в список.
  await Promise.all(
    runProcessGroups(id)
      .filter((group) => group !== `${id}:preview`)
      .map(killGroup),
  );
  await stopPreview(k, id);
  if (r) {
    if (r.workspace !== 'branch' && isInside(k.store.worktreesDir(), r.worktreePath) && fs.existsSync(r.worktreePath))
      await git.removeWorktree(r.projectPath, r.worktreePath).catch(traced('deleteRun: worktree'));
    if (deleteBranch) await git.deleteBranch(r.projectPath, r.branch).catch(traced('deleteRun: branch'));
    if (r.root && isInside(k.store.worktreesDir(), r.root.dir)) await removeRepoWorktrees(git, r, deleteBranch);
  }
  for (const dir of [attachmentsDir(k, id), path.join(k.opts.dataDir, 'visual', id)]) fs.rmSync(dir, { recursive: true, force: true });
  k.store.forget(id);
  k.emit({ type: 'run.deleted', runId: id });
  void pump(k);
}
