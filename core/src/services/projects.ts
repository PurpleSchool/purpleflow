// Проекты: сохранённые команды, знания (профиль и уроки), проверка окружения, обзор и статистика.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { addUsage, c, emptyUsage, type AgentResult } from '../agents/common.js';
import { prependPath } from '../env.js';
import { Git } from '../git.js';
import { prReadiness } from '../github.js';
import { isRunBranch } from '../ids.js';
import { parseJsonReply } from '../json.js';
import type { Kernel } from '../kernel.js';
import { expandPorts, portEnv, waitForUrl } from '../net.js';
import { parseNextParts } from '../parse.js';
import { killGroup, run as runProc } from '../proc.js';
import { ARTIFACT_RE } from '../reviewdiff.js';
import { projectStats as computeProjectStats } from '../stats.js';
import type {
  AiCommands,
  EnvCheck,
  ModeSuggestion,
  NextPartDraft,
  ProjectBranches,
  ProjectConfig,
  ProjectKnowledge,
  ProjectListItem,
  ProjectOverview,
  ProjectStats,
  RelatedRepo,
  RunFile,
  RunMode,
  StageAttempt,
} from '../types.js';
import { service } from './agents.js';
import { ghBin } from './pr.js';
import { getChangeDocs } from './runs.js';
import { prepareApp } from './workspace.js';
export function knowledgeOf(k: Kernel, repo: string): ProjectKnowledge {
  return getProjectConfig(k, repo)?.knowledge ?? {};
}

export function updateKnowledge(k: Kernel, repo: string, fn: (kn: ProjectKnowledge) => ProjectKnowledge) {
  const all = k.store.readProjects();
  const key = path.resolve(repo);
  const cfg: ProjectConfig = all[key] ?? {
    setupCommand: '',
    lintCommand: '',
    testCommand: '',
    notes: { setup: '', lint: '', test: '' },
    updatedAt: new Date().toISOString(),
  };
  k.store.writeProject(key, { ...cfg, knowledge: fn(cfg.knowledge ?? {}) });
}

/** Блок для системного промпта агентов. */
export function knowledgeBlock(k: Kernel, run: RunFile): string {
  const kn = knowledgeOf(k, run.projectPath);
  const lessons = kn.lessons?.map((l) => `- ${l.text}`).join('\n');
  const related = relatedBlock(k, run.projectPath);
  if (!kn.profile && !lessons) return related;
  return (
    related +
    `\n\n## Знания о проекте\n\nСобраны в прошлых прогонах — опирайся на них, но если код говорит иное, верь коду.${kn.profile ? `\n\n### Профиль\n\n${kn.profile.trim()}` : ''}${lessons ? `\n\n### Уроки прошлых прогонов\n\n${lessons}` : ''}`
  );
}

/** Соседние репозитории проекта, которые есть на диске. */
export function relatedRepos(k: Kernel, repo: string): RelatedRepo[] {
  return (getProjectConfig(k, repo)?.relatedRepos ?? []).filter((r) => fs.existsSync(r.path));
}

/** Блок для агентов: где лежат соседние репозитории и что их можно только читать. */
export function relatedBlock(k: Kernel, repo: string): string {
  const list = relatedRepos(k, repo);
  if (!list.length) return '';
  return `\n\n## Соседние репозитории (только чтение)\n\nЗадача делается в текущем репозитории, но он работает вместе с соседними. Читай их, чтобы сверяться с контрактами (API, типы, события, конфиги), — инструментами Read, Grep, Glob по абсолютным путям. Ничего в них не меняй: ни файлов, ни git. Если для задачи нужна правка соседа — напиши об этом в отчёте.\n\n${list.map((r) => `- \`${r.path}\`${r.note ? ` — ${r.note}` : ''}`).join('\n')}`;
}

/** Отпечатки соседних репозиториев (только git) — до и после работы исполнителя. */
export async function relatedState(k: Kernel, repo: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = relatedRepos(k, repo);
  if (!list.length) return out;
  const tools = await k.tools(['git']).catch(() => null);
  if (!tools) return out;
  const git = new Git(tools.git, k.opts.env);
  for (const r of list) {
    const f = await git.fingerprint(r.path).catch(() => null);
    if (f !== null) out.set(r.path, f);
  }
  return out;
}

/** Исполнитель мог записать в соседний репозиторий (у claude запись туда не запретить) — предупреждаем человека. */
export async function checkRelatedUntouched(k: Kernel, run: RunFile, before: Map<string, string>) {
  if (!before.size) return;
  const after = await relatedState(k, run.projectPath);
  const changed = [...before].filter(([p, f]) => after.has(p) && after.get(p) !== f).map(([p]) => p);
  if (changed.length)
    k.warn(
      run,
      `Пока работал исполнитель, изменились соседние репозитории: ${changed.join(', ')}. Агентам туда писать нельзя — проверьте git status в них, если меняли не вы.`,
    );
}

export async function profileFor(k: Kernel, repo: string, cwd: string, onOutput: (t: string) => void, group: string): Promise<AgentResult> {
  return service(k, { prompt: k.prompts.raw('profile.md'), cwd, group, onOutput, timeoutMs: 10 * 60_000, tools: ['Read', 'Glob', 'Grep'] });
}

/** Профиль проекта — один раз, перед первым планом. Сбой не останавливает прогон. */
export async function ensureProfile(k: Kernel, run: RunFile, attempt: StageAttempt) {
  if (knowledgeOf(k, run.projectPath).profile) return;
  k.log(run, c.dim('Изучаю проект для профиля — один раз, дальше он достаётся всем агентам…') + '\n');
  const res = await profileFor(k, run.projectPath, run.worktreePath, (t) => k.log(run, c.dim(t), false), run.id);
  attempt.tokens = addUsage(attempt.tokens ?? emptyUsage(), res.usage);
  run.totals = addUsage(run.totals, res.usage);
  k.checkStop(run);
  if (!res.ok || !res.text.trim()) {
    k.log(run, c.amber(`! профиль проекта не собран: ${res.error ?? 'пустой ответ'} — продолжаю без него`) + '\n');
    return;
  }
  updateKnowledge(k, run.projectPath, (kn) => ({ ...kn, profile: res.text.trim(), profileAt: new Date().toISOString() }));
  k.log(run, c.mint('✓ профиль проекта сохранён — его можно поправить в «Проекты → Знания о проекте»') + '\n');
}

/** Пересобрать профиль по кнопке в «Знаниях о проекте». */
export async function refreshProfile(k: Kernel, repo: string): Promise<ProjectKnowledge> {
  const res = await profileFor(k, repo, repo, () => {}, `profile-${Date.now()}`);
  if (!res.ok || !res.text.trim()) throw new Error(res.error ?? 'Нейросеть вернула пустой профиль');
  updateKnowledge(k, repo, (kn) => ({ ...kn, profile: res.text.trim(), profileAt: new Date().toISOString() }));
  return knowledgeOf(k, repo);
}

export function saveKnowledge(k: Kernel, repo: string, kn: ProjectKnowledge): ProjectKnowledge {
  updateKnowledge(k, repo, () => ({
    profile: kn.profile?.trim() || undefined,
    profileAt: kn.profileAt,
    lessons: kn.lessons?.filter((l) => l.text.trim()).map((l) => ({ ...l, text: l.text.trim() })),
  }));
  return knowledgeOf(k, repo);
}

export function getKnowledge(k: Kernel, repo: string): ProjectKnowledge {
  return knowledgeOf(k, repo);
}

export async function learn(k: Kernel, run: RunFile) {
  // Круг по PR: уроки только из его замечаний — прошлые круги уже разобраны.
  const since = run.prRound ? (run.prRounds?.at(-1)?.at ?? '') : '';
  const prItems = run.prRound
    ? (run.prRounds?.at(-1)?.items ?? [])
        .filter((i) => i.kind !== 'check')
        .map((i) => `- ревьюер PR @${i.author}: ${i.path ? `${i.path} — ` : ''}${i.body.slice(0, 400)}`)
    : [];
  const human = run.gates
    .filter((g) => g.at >= since && (g.decision === 'reject' || g.decision === 'fix') && (g.comment || g.lineComments?.length))
    .map(
      (g) =>
        `- человек (${g.gate === 'gate1' ? 'план' : 'приёмка'}): ${g.comment ?? ''}${g.lineComments?.length ? ' ' + g.lineComments.map((l) => `[${l.file}:${l.line}] ${l.text}`).join('; ') : ''}`,
    );
  const review = run.reviews
    .filter((r) => r.at >= since)
    .flatMap((r) => [...r.blocking, ...r.notes])
    .slice(0, 12)
    .map((i) => `- ревью: ${i.file ? `${i.file} — ` : ''}${i.message}`);
  const visual = (run.visuals ?? []).flatMap((v) => [
    ...(v.unverified ? [`- визуальная проверка не смогла проверить: ${v.unverified}`] : []),
    ...v.blocking.map((b) => `- визуальная проверка: ${b.message}`),
  ]);
  const failed = run.tests
    .filter((t) => !t.passed)
    .slice(0, 3)
    .map(
      (t) =>
        `- проверки упали: ${(t.checks ?? [])
          .filter((x) => !x.passed && !x.preexisting && !x.unstable)
          .map((x) => x.command)
          .join(', ')}`,
    );
  const digest = [...prItems, ...human, ...review, ...visual, ...failed].join('\n').slice(0, 6000);
  if (!digest.trim()) return;
  const known = knowledgeOf(k, run.projectPath).lessons ?? [];
  const res = await service(k, {
    prompt: k.prompts.render('lessons.md', { known: known.map((l) => `- ${l.text}`).join('\n') || '(пока нет)', digest }),
    group: `${run.id}:learn`,
    timeoutMs: 3 * 60_000,
  }).catch(() => null);
  if (!res?.ok) return;
  const j = parseJsonReply<{ lessons?: unknown }>(res.text) ?? {};
  const lessons: string[] = Array.isArray(j.lessons)
    ? j.lessons.filter((x): x is string => typeof x === 'string' && x.trim().length > 3).slice(0, 5)
    : [];
  const seen = new Set(known.map((l) => l.text.toLowerCase()));
  const fresh = lessons.map((t) => t.trim()).filter((t) => !seen.has(t.toLowerCase()));
  if (!fresh.length) return;
  const at = new Date().toISOString();
  // Не больше 40 уроков: старые уходят первыми.
  updateKnowledge(k, run.projectPath, (kn) => ({
    ...kn,
    lessons: [...(kn.lessons ?? []), ...fresh.map((text) => ({ text, at, runId: run.id }))].slice(-40),
  }));
  k.log(run, c.violet(`✦ уроки для следующих прогонов (+${fresh.length}):\n`) + fresh.map((t) => `  • ${t}`).join('\n') + '\n');
}

/** Проекты, с которыми работали: настроенные и те, где были прогоны. Сначала недавние. */
export function listProjects(k: Kernel): ProjectListItem[] {
  const map = new Map<string, ProjectListItem>();
  for (const [p, cfg] of Object.entries(k.store.readProjects())) {
    map.set(p, { path: p, configured: true, exists: fs.existsSync(p), updatedAt: cfg.updatedAt, runs: 0, active: 0, lastRunAt: null });
  }
  for (const r of k.store.list()) {
    const p = path.resolve(r.projectPath);
    const it = map.get(p) ?? { path: p, configured: false, exists: fs.existsSync(p), runs: 0, active: 0, lastRunAt: null };
    it.runs++;
    if (r.status === 'running' || r.status === 'waiting' || r.status === 'queued') it.active++;
    if (!it.lastRunAt || r.createdAt > it.lastRunAt) it.lastRunAt = r.createdAt;
    map.set(p, it);
  }
  const at = (x: ProjectListItem) => x.lastRunAt ?? x.updatedAt ?? '';
  return [...map.values()].sort((a, b) => at(b).localeCompare(at(a)));
}

/** Следующая часть большой задачи: из «Next Parts» плана — текст задачи и вложения для нового прогона. */
export async function nextPartDraft(k: Kernel, id: string): Promise<NextPartDraft | null> {
  const r = k.mustLoad(id);
  const docs = await getChangeDocs(k, id).catch(() => null);
  const parts = parseNextParts(docs?.proposal ?? '');
  if (!parts.length) return null;
  const [next, ...rest] = parts;
  const done = r.commit ? `в ветке \`${r.branch}\` (коммит ${r.commit.slice(0, 8)})` : `в ветке \`${r.branch}\``;
  const task = [
    `Следующая часть задачи «${r.title}». Предыдущая часть уже сделана ${done}${r.merged ? ` и влита в \`${r.merged.into}\`` : r.pr?.url ? `, PR: ${r.pr.url}` : ''}.`,
    '',
    `Сейчас нужно сделать: ${next}`,
    rest.length ? `\nПосле этой части останутся (в эту задачу не входят): ${rest.map((x) => `\n- ${x}`).join('')}` : '',
    '',
    'Исходная задача целиком — для контекста:',
    '',
    r.task,
  ].join('\n');
  return {
    projectPath: r.projectPath,
    task,
    attachments: r.attachments ?? [],
    baseBranch: r.merged?.into || r.pr?.base || r.baseBranch,
    rest,
  };
}

/**
 * Проверка окружения перед задачами: команда запуска поднимает приложение в папке проекта, агент в браузере
 * пробует вход и разделы из инструкции для проверки. Сборочные артефакты, которые поменял dev-сервер, откатываются.
 */
export async function checkEnvironment(k: Kernel, repo: string): Promise<EnvCheck> {
  const key = path.resolve(repo);
  const at = new Date().toISOString();
  const cfg = getProjectConfig(k, key);
  if (!cfg?.runCommand?.trim() || !cfg.appUrl?.trim())
    return { ready: false, steps: [], fix: 'Задайте команду запуска приложения и адрес в командах проекта.', at };
  if (k.envChecks.has(key)) throw new Error('Проверка окружения уже идёт');
  k.envChecks.add(key);
  const s = k.opts.getSettings();
  const agent = s.agents?.visual ?? 'claude';
  if (!(await k.hasTool(agent))) {
    k.envChecks.delete(key);
    return {
      ready: false,
      steps: [],
      fix: `Проверка окружения управляет браузером через ${agent} (агент визуальной проверки), а он не найден. Установите его или выберите другого агента в настройках моделей.`,
      at,
    };
  }
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  const dirtyBefore = new Set(await git.dirtyFiles(key).catch(() => [] as string[]));
  const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  const dir = path.join(k.opts.dataDir, 'envcheck', id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const group = `envcheck:${id}`;
  const { port, url, command } = await expandPorts(cfg.appUrl.trim(), cfg.runCommand.trim());
  let out = '';
  try {
    await prepareApp(k, {
      repo: key,
      cwd: key,
      group,
      onOutput: (t) => {
        out = (out + t).slice(-8000);
      },
    });
  } catch (e) {
    k.envChecks.delete(key);
    return {
      ready: false,
      url,
      command,
      at,
      serverOutput: out.trim(),
      steps: [{ title: 'Подготовка к запуску', ok: false, detail: (e as Error).message }],
      fix: 'Поправьте команду «Подготовка к запуску» в командах проекта.',
    };
  }
  let exited: number | null | undefined;
  const server = runProc(command, [], {
    cwd: key,
    env: { ...k.opts.env, ...portEnv(cfg.runCommand, port), BROWSER: 'none', CI: '1' },
    shell: true,
    group,
    onStdout: (t) => {
      out = (out + t).slice(-8000);
    },
    onStderr: (t) => {
      out = (out + t).slice(-8000);
    },
  });
  void server.then((r) => {
    exited = r.code;
  });
  const session = `purpleflow-env-${id}`;
  try {
    const ready = await waitForUrl(url, 150_000, () => exited !== undefined);
    if (!ready) {
      return {
        ready: false,
        url,
        command,
        at,
        serverOutput: out.trim(),
        steps: [
          {
            title: 'Приложение запускается',
            ok: false,
            detail: exited !== undefined ? `Команда завершилась с кодом ${exited}, не открыв ${url}` : `За 2,5 минуты ${url} не ответил`,
          },
        ],
        fix: 'Посмотрите вывод сервера: обычно не хватает базы, переменных в .env или порт задан не через {port}.',
      };
    }
    fs.writeFileSync(path.join(dir, 'pw'), `#!/bin/sh\ncd "${dir}" && exec npx -y @playwright/cli@latest -s=${session} "$@"\n`, {
      mode: 0o755,
    });
    const res = await service(k, {
      prompt: k.prompts.render('env-check.md', {
        url,
        notes: cfg.visualNotes?.trim() || '(нет)',
        server: out.replace(/\x1b\[[0-9;]*m/g, '').slice(-4000) || '(пусто)',
      }),
      cwd: key,
      env: prependPath(k.opts.env, dir),
      group,
      addDirs: [dir],
      tools: ['Bash', 'Read', 'Glob', 'Grep'],
      model: s.models.visual || undefined,
      agent,
      fullAccess: true,
      userConfig: s.userConfig ?? true,
      timeoutMs: 20 * 60_000,
      idleTimeoutMs: 6 * 60_000,
    });
    const j = parseJsonReply<{ ready?: boolean; steps?: { title?: string; ok?: boolean; detail?: string }[]; fix?: string }>(res.text);
    if (!res.ok || !j) {
      return {
        ready: false,
        url,
        command,
        at,
        serverOutput: out.trim(),
        steps: [
          { title: 'Приложение запускается', ok: true, detail: `${url} отвечает` },
          { title: 'Проверка в браузере', ok: false, detail: res.error ?? 'Агент ответил не в формате JSON' },
        ],
      };
    }
    return {
      ready: Boolean(j.ready),
      url,
      command,
      at,
      serverOutput: out.trim(),
      fix: j.fix?.trim() || undefined,
      steps: [
        { title: 'Приложение запускается', ok: true, detail: `${url} отвечает` },
        ...(j.steps ?? []).map((x) => ({ title: String(x.title ?? ''), ok: Boolean(x.ok), detail: String(x.detail ?? '') })),
      ],
    };
  } finally {
    await runProc('npx', ['-y', '@playwright/cli@latest', `-s=${session}`, 'close'], {
      cwd: dir,
      env: k.opts.env,
      timeoutMs: 20_000,
    }).catch(() => undefined);
    await killGroup(group);
    // Dev-сервер мог переписать отслеживаемые артефакты (next-env.d.ts, tsbuildinfo) — рабочая копия остаётся как была.
    const touched = (await git.dirtyFiles(key).catch(() => [] as string[])).filter((f) => !dirtyBefore.has(f) && ARTIFACT_RE.test(f));
    if (touched.length) await git.restoreFromBase(key, 'HEAD', touched).catch(() => undefined);
    k.envChecks.delete(key);
  }
}

/** Незакоммиченные изменения в рабочей копии проекта — по кнопке человека перед стартом в режиме «Ветка». */
export async function cleanWorkingCopy(k: Kernel, repo: string, how: 'stash' | 'discard'): Promise<{ files: number }> {
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  const dirty = await git.dirtyFiles(repo);
  if (!dirty.length) return { files: 0 };
  if (how === 'stash') await git.stashAll(repo, `PurpleFlow: перед новой задачей ${new Date().toLocaleString('ru-RU')}`);
  else await git.discardAll(repo);
  return { files: dirty.length };
}

/** Состояние репозитория проекта для страницы «Обзор». */
export async function projectOverview(k: Kernel, repo: string): Promise<ProjectOverview> {
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  const [branch, dirty, remote, pr] = await Promise.all([
    git.currentBranch(repo).catch(() => null),
    git
      .dirtyFiles(repo)
      .then((f) => f.length)
      .catch(() => 0),
    runProc(tools.git, ['remote', 'get-url', 'origin'], { cwd: repo, env: k.opts.env, timeoutMs: 10_000 })
      .then((x) => (x.code === 0 ? x.stdout.trim() : null))
      .catch(() => null),
    prReadiness(ghBin(k), tools.git, repo, k.opts.env).catch((e) => String((e as Error).message)),
  ]);
  return { branch, dirty, remote, prReady: pr };
}

/** Статистика по прогонам проекта. */
export function projectStats(k: Kernel, repo: string): ProjectStats {
  const root = path.resolve(repo);
  const runs = k.store
    .list()
    .filter((r) => !r.missing && path.resolve(r.projectPath) === root)
    .map((r) => k.store.load(r.id))
    .filter((r): r is RunFile => Boolean(r));
  return computeProjectStats(runs);
}

/** Ветки проекта для «От ветки» в новой задаче. fetch — сначала подтянуть ветки origin. */
export async function projectBranches(k: Kernel, repo: string, fetch = false): Promise<ProjectBranches> {
  const tools = await k.tools(['git']);
  const all = await new Git(tools.git, k.opts.env).allBranches(repo, fetch);
  // Ветки прогонов PurpleFlow — в конец: от них новые задачи начинают редко.
  const own = (b: { name: string }) => isRunBranch(b.name);
  return { current: all.current, branches: [...all.branches.filter((b) => !own(b)), ...all.branches.filter(own)] };
}

/** Убрать проект из списка: команды и знания удаляются, прогоны остаются. */
export function forgetProject(k: Kernel, repo: string): void {
  k.store.removeProject(path.resolve(repo));
}

/** Сохранённые команды проекта (null — ещё не настраивали). */
export function getProjectConfig(k: Kernel, repo: string): ProjectConfig | null {
  return k.store.readProjects()[path.resolve(repo)] ?? null;
}

export function saveProjectConfig(k: Kernel, repo: string, cfg: Omit<ProjectConfig, 'updatedAt'>): ProjectConfig {
  const full: ProjectConfig = {
    setupCommand: cfg.setupCommand.trim(),
    lintCommand: cfg.lintCommand.trim(),
    testCommand: cfg.testCommand.trim(),
    quickTestCommand: cfg.quickTestCommand?.trim() || undefined,
    prepareCommand: cfg.prepareCommand?.trim() || undefined,
    runCommand: cfg.runCommand?.trim() || undefined,
    appUrl: cfg.appUrl?.trim() || undefined,
    visualNotes: cfg.visualNotes?.trim() || undefined,
    envFiles: cfg.envFiles?.map((f) => f.trim()).filter(Boolean),
    relatedRepos: cfg.relatedRepos
      ?.map((r) => ({ path: path.resolve(r.path.trim()), note: r.note?.trim() || undefined }))
      .filter((r) => r.path && r.path !== path.resolve(repo)),
    workspace: cfg.workspace,
    notes: cfg.notes,
    // Знания собираются отдельно — сохранение команд их не трогает.
    knowledge: cfg.knowledge ?? getProjectConfig(k, repo)?.knowledge,
    updatedAt: new Date().toISOString(),
  };
  k.store.writeProject(path.resolve(repo), full);
  return full;
}

/**
 * Нейросеть осматривает проект (только чтение: Read/Glob/Grep) и предлагает команды
 * подготовки, линтера и тестов. Работает в папке проекта, ничего не меняя.
 */
export async function detectCommandsAI(k: Kernel, dir: string): Promise<AiCommands> {
  const res = await service(k, {
    prompt: k.prompts.raw('detect-commands.md'),
    cwd: dir,
    group: `detect-${Date.now()}`,
    timeoutMs: 3 * 60_000,
    tools: ['Read', 'Glob', 'Grep'],
  });
  if (!res.ok) throw new Error(res.error ?? 'Не удалось определить команды');
  try {
    const j = parseJsonReply<Record<string, unknown>>(res.text);
    if (!j) throw new Error('не JSON');
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const notes = (j.notes ?? {}) as Record<string, unknown>;
    return {
      setupCommand: str(j.setup),
      lintCommand: str(j.lint),
      testCommand: str(j.test),
      runCommand: str(j.run),
      appUrl: str(j.url),
      visualNotes: str(j.visual),
      notes: { setup: str(notes.setup), lint: str(notes.lint), test: str(notes.test), run: str(notes.run) },
    };
  } catch {
    throw new Error(`Нейросеть ответила не в формате JSON: ${res.text.slice(0, 300)}`);
  }
}

/** Режим по тексту задачи — подсказка человеку, решение за ним. */
export async function suggestMode(k: Kernel, task: string): Promise<ModeSuggestion> {
  const res = await service(k, { prompt: k.prompts.render('suggest-mode.md', { task }), group: `mode-${Date.now()}`, timeoutMs: 90_000 });
  if (!res.ok) throw new Error(res.error ?? 'Не удалось определить режим');
  try {
    const j = parseJsonReply<Record<string, unknown>>(res.text);
    if (!j) throw new Error('не JSON');
    const modes: RunMode[] = ['quick', 'bug', 'task', 'epic', 'refactor'];
    return { mode: modes.includes(j.mode as RunMode) ? (j.mode as RunMode) : 'task', reason: String(j.reason ?? '').trim() };
  } catch {
    throw new Error(`Нейросеть ответила не в формате JSON: ${res.text.slice(0, 200)}`);
  }
}
