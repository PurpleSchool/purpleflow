// Рабочая копия прогона: worktree или ветка в проекте, файлы окружения, зависимости, подготовка приложения.
import fs from 'node:fs';
import path from 'node:path';
import { c } from '../agents/common.js';
import { Git } from '../git.js';
import type { Kernel } from '../kernel.js';

import { OpenSpec } from '../openspec.js';
import { run as runProc } from '../proc.js';
import { traced } from '../trace.js';
import type { RunFile } from '../types.js';
import { getProjectConfig } from './projects.js';
/** От какого коммита считать дифф: в круге доработки по PR — только правки этого круга. */
export function diffBase(k: Kernel, run: RunFile): string {
  return run.prRound && run.roundBase ? run.roundBase : run.baseCommit;
}

/** Рабочая копия прогона: worktree или новая ветка в проекте, OpenSpec, файлы окружения. Для очереди — в момент старта. */
export async function prepareWorkspace(k: Kernel, run: RunFile) {
  const tools = await k.tools(['git', 'openspec']);
  const git = new Git(tools.git, k.opts.env);
  if (run.workspace === 'branch') {
    // Чужие незакоммиченные правки попали бы в коммит прогона — поэтому только с чистой копией.
    const dirty = await git.dirtyFiles(run.projectPath);
    if (dirty.length) {
      throw new Error(
        `В рабочей копии есть незакоммиченные изменения (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? '…' : ''}). Закоммитьте или спрячьте их (git stash) — или выберите отдельную копию (worktree).`,
      );
    }
    run.originalBranch = (await git.currentBranch(run.projectPath)) ?? undefined;
    await git.checkoutNewBranch(run.projectPath, run.branch, run.baseCommit);
  } else {
    await git.addWorktree(run.projectPath, run.worktreePath, run.branch, run.baseCommit);
  }
  if (run.mode !== 'quick') {
    await new OpenSpec(tools.openspec, k.opts.env).ensureInit(run.worktreePath, 'init').catch(async (e) => {
      await undoWorkspace(git, run).catch(traced('prepareWorkspace: откат'));
      throw e;
    });
  }
  run.workspacePending = undefined;
  k.save(run);
  copyEnvFiles(k, run);
  await cloneDeps(k, run).catch((e) =>
    k.warn(run, `Не удалось скопировать зависимости — команда подготовки поставит их заново: ${(e as Error).message}`),
  );
  k.save(run);
  k.log(
    run,
    c.dim(
      `PurpleFlow · ${run.changeId}\nветка ${run.branch} от ${run.baseBranch ? `${run.baseBranch} (${run.baseCommit.slice(0, 8)})` : run.baseCommit.slice(0, 8)}\n${run.workspace === 'branch' ? `рабочая копия проекта ${run.projectPath} (была ветка ${run.originalBranch ?? 'detached HEAD'})` : `worktree ${run.worktreePath}`}\n`,
    ),
  );
}

/**
 * Откат созданной рабочей копии: иначе проект остался бы на чужой ветке,
 * а следующая попытка упёрлась бы в «ветка уже есть». Копия была чистой — выбрасывать в ней нечего, кроме следов init.
 */
async function undoWorkspace(git: Git, run: RunFile) {
  if (run.workspace === 'branch') {
    await git.discardAll(run.projectPath);
    await git.checkout(run.projectPath, run.originalBranch ?? run.baseCommit);
  } else {
    await git.removeWorktree(run.projectPath, run.worktreePath);
  }
  await git.deleteBranch(run.projectPath, run.branch);
}

/** Файлы окружения прогона: явный список или найденные в проекте (у прогонов без списка — из команд проекта). */
export function envFilesOf(k: Kernel, run: RunFile): string[] {
  if (run.workspace === 'branch') return [];
  return run.envFiles ?? getProjectConfig(k, run.projectPath)?.envFiles ?? [];
}

/** Скопировать .env-файлы проекта в worktree прогона (только недостающие; в режиме «ветка» они и так на месте). */
export function copyEnvFiles(k: Kernel, run: RunFile) {
  const files = envFilesOf(k, run);
  const copied: string[] = [];
  for (const rel of files) {
    const from = path.join(run.projectPath, rel);
    const to = path.join(run.worktreePath, rel);
    if (path.relative(run.projectPath, from).startsWith('..') || !fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(rel);
    } catch {
      /* нет доступа — проверки покажут, чего не хватает */
    }
  }
  if (copied.length) k.log(run, c.dim(`файлы окружения скопированы в worktree: ${copied.join(', ')}`) + '\n');
}

/**
 * Зависимости в worktree — копией node_modules из проекта через copy-on-write (APFS `cp -c`, Linux `--reflink`):
 * почти мгновенно, места не занимает, и копия независимая — установка пакетов в worktree не трогает проект.
 * Lock-файлы совпадают — установка пропускается; нет — команда подготовки доустановит поверх копии.
 */
export async function cloneDeps(k: Kernel, run: RunFile) {
  if (run.workspace === 'branch' || process.platform === 'win32') return;
  const found: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(run.projectPath, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name.startsWith('.next') || e.name === 'dist' || e.name === 'build') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') found.push(child);
      else if (depth < 3) walk(child, depth + 1);
    }
  };
  walk('', 0);
  if (!found.length) return;
  const t0 = Date.now();
  const cloned: string[] = [];
  for (const rel of found) {
    const to = path.join(run.worktreePath, rel);
    if (fs.existsSync(to) || !fs.existsSync(path.dirname(to))) continue;
    const args =
      process.platform === 'darwin'
        ? ['-cR', path.join(run.projectPath, rel), to]
        : ['-R', '--reflink=auto', path.join(run.projectPath, rel), to];
    const r = await runProc('cp', args, { cwd: run.worktreePath, env: k.opts.env, timeoutMs: 5 * 60_000, group: run.id });
    k.checkStop(run);
    if (r.code === 0) cloned.push(rel);
    else fs.rmSync(to, { recursive: true, force: true });
  }
  if (!cloned.length) return;
  const locks = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];
  const same = locks.every((f) => {
    const a = path.join(run.projectPath, f);
    const b = path.join(run.worktreePath, f);
    if (!fs.existsSync(a) && !fs.existsSync(b)) return true;
    try {
      return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch {
      return false;
    }
  });
  const sec = Math.round((Date.now() - t0) / 1000);
  if (same) {
    run.prepared = true;
    k.log(
      run,
      c.dim(`зависимости скопированы из проекта (${cloned.join(', ')}, ${sec} с) — lock-файлы совпадают, установка пропущена`) + '\n',
    );
  } else {
    k.log(run, c.dim(`зависимости скопированы из проекта (${sec} с); lock-файлы отличаются — команда подготовки доустановит`) + '\n');
  }
}

/**
 * «Подготовка к запуску» из команд проекта (миграции, сиды) — перед каждым запуском приложения:
 * в визуальной проверке, во вкладке «Браузер» и в проверке окружения. Свежая команда из настроек проекта.
 * Упала — ошибка с хвостом вывода: без миграций приложение всё равно не заработает.
 */
export async function prepareApp(
  k: Kernel,
  o: { repo: string; cwd: string; group: string; onOutput?: (t: string) => void },
): Promise<void> {
  const cmd = getProjectConfig(k, o.repo)?.prepareCommand?.trim();
  if (!cmd) return;
  let out = '';
  const take = (t: string) => {
    out = (out + t).slice(-4000);
    o.onOutput?.(t);
  };
  o.onOutput?.(`$ ${cmd}\n`);
  const r = await runProc(cmd, [], {
    cwd: o.cwd,
    env: { ...k.opts.env, CI: '1' },
    shell: true,
    group: o.group,
    timeoutMs: 10 * 60_000,
    onStdout: take,
    onStderr: take,
  });
  if (r.code !== 0) {
    const why = r.spawnError ?? (r.timedOut ? 'не уложилась в 10 минут' : `завершилась с кодом ${r.code}`);
    throw new Error(
      `Подготовка к запуску (${cmd}) ${why}:\n${out
        .replace(/\x1b\[[0-9;]*m/g, '')
        .trim()
        .slice(-1500)}`,
    );
  }
}

/** Режим «ветка»: продолжать можно, только если проект всё ещё на ветке прогона. */
export async function ensureOnBranch(k: Kernel, r: RunFile) {
  if (r.workspace !== 'branch') return;
  const tools = await k.tools(['git']);
  const cur = await new Git(tools.git, k.opts.env).currentBranch(r.projectPath);
  if (cur !== r.branch)
    throw new Error(
      `Проект сейчас на ветке ${cur ?? 'detached HEAD'}. Переключитесь на ${r.branch} (git checkout ${r.branch}) и продолжите.`,
    );
}
