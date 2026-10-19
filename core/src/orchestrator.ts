import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from './agents/claude.js';
import { runCodex } from './agents/codex.js';
import { addUsage, c, crlf, emptyUsage, type AgentResult } from './agents/common.js';
import { detectTools, prependPath } from './env.js';
import { Git } from './git.js';
import { acceptTarget, afterChecks } from './route.js';
import { makeChangeId, makeTitle } from './ids.js';
import { killGroup, killPid, run as runProc, setPidTracker } from './proc.js';
import { Prompts } from './prompts.js';
import { RunStore } from './store.js';
import { Screencast } from './screencast.js';
import { browserLeftovers, screenshots, sizeOfAll, subdirs } from './storage.js';
import { MODE_FIRST, MODE_LIMIT, modeOf } from './modes.js';
import { DEFAULT_AGENTS } from './types.js';
import type { ChatSummary, ControlAction, ManagerMessage, NextPartDraft, EnvCheck, AgentKind, Role, PrStatus, ProjectListItem, ProjectOverview, ProjectStats, ProjectBranches, PrDetails, PrFollowupItem, ProjectKnowledge, AiCommands, CheckResult, ModeSuggestion, PreviewState, StorageItem, ProjectConfig, ConnectionCheck, CoreCommand, CoreEvent, DiffFile, Feedback, GateId, LineComment, ReviewItem, ReviewResult, RunFile, RunSummary, StageAttempt, StageId, StartRunInput, TestResult, ToolInfo, ToolName } from './types.js';
import { CoreOptions, IMPL_LIMIT, Listener, STAGE_TITLES, StopSignal, Tools, expandPorts, isGate, isImageFile, portEnv, readSmallText, waitForUrl } from './shared.js';
export * from './shared.js';
import { runChecks, runCheck, probeTests, checksFeedback, captureBaseChecks, compareWithBase, stageTests, stageBaseline, needsReview } from './pipeline/checks.js';
import { summaryContext, summarizeChanges, mapFilesToPlan, previousReviewBlock, stageReview, reviewPass, verifyBlocking, reviewFeedback } from './pipeline/review.js';
import { visualDir, stageVisual, startLiveBrowser, getVisualShot } from './pipeline/visual.js';
import { stageClarify, answer, stagePlan, startFilesBlock } from './pipeline/plan.js';
import { stageImplement, dropArtifacts } from './pipeline/implement.js';
import { stageFinish } from './pipeline/finish.js';
import { applyPending, control } from './pipeline/control.js';
import { askManager, getManagerChat, resolveManagerAction } from './pipeline/manager.js';
import { chatChangedFiles, chatDiff, chatToTask, createChat, deleteChat, getChat, listChats, sendChat, startChatPreview, stopChat, updateChat } from './pipeline/chat.js';
import { ghBin, prReady, openPr, prBody, getPrStatus, getPrDetails, prFollowup, reopenWorkspace, updateBranch, mergePrOf, listBranches, merge } from './pipeline/pr.js';
import { knowledgeOf, updateKnowledge, knowledgeBlock, relatedRepos, relatedState, checkRelatedUntouched, profileFor, ensureProfile, refreshProfile, saveKnowledge, getKnowledge, learn, listProjects, nextPartDraft, checkEnvironment, cleanWorkingCopy, projectOverview, projectStats, projectBranches, forgetProject, getProjectConfig, saveProjectConfig, detectCommandsAI, suggestMode } from './pipeline/projects.js';
import { diffBase, prepareWorkspace, envFilesOf, copyEnvFiles, cloneDeps, prepareApp } from './pipeline/workspace.js';
export class Orchestrator {
  listeners = new Set<Listener>();
  store: RunStore;
  prompts: Prompts;
  /** Прогоны, по которым сейчас крутится цикл стадий. */
  driving = new Set<string>();
  stopping = new Set<string>();

  constructor(readonly opts: CoreOptions) {
    this.store = new RunStore(opts.dataDir);
    this.prompts = new Prompts(opts.promptsDir);
    const store = this.store;
    setPidTracker({
      add: (g, pid) => store.writePids(g, [...store.readPids(g).filter((p) => p !== pid), pid]),
      remove: (g, pid) => store.writePids(g, store.readPids(g).filter((p) => p !== pid)),
    });
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: CoreEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch { /* слушатель UI не должен ронять ядро */ }
    }
  }

  // ——— Команды ———

  async dispatch(cmd: CoreCommand): Promise<{ runId: string }> {
    switch (cmd.type) {
      case 'run.start':
        return { runId: await this.start(cmd.input) };
      case 'run.resume':
        await this.resume(cmd.runId);
        return { runId: cmd.runId };
      case 'gate.approve':
        await this.decide(cmd.runId, 'approve', cmd.comment);
        return { runId: cmd.runId };
      case 'gate.reject':
        await this.decide(cmd.runId, 'reject', cmd.comment, cmd.lineComments);
        return { runId: cmd.runId };
      case 'gate.cancel':
        await this.decide(cmd.runId, 'cancel');
        return { runId: cmd.runId };
      case 'gate.accept':
        await this.decide(cmd.runId, 'accept');
        return { runId: cmd.runId };
      case 'gate.fix':
        await this.decide(cmd.runId, 'fix', cmd.comment, cmd.lineComments);
        return { runId: cmd.runId };
      case 'gate.answer':
        await this.answer(cmd.runId, cmd.answers);
        return { runId: cmd.runId };
      case 'run.stop':
        await this.stop(cmd.runId);
        return { runId: cmd.runId };
      case 'run.control':
        await this.control(cmd.runId, cmd.action);
        return { runId: cmd.runId };
      case 'run.skipChecks':
        await this.skipChecks(cmd.runId);
        return { runId: cmd.runId };
      case 'run.rerunVisual':
        await this.rerunVisual(cmd.runId);
        return { runId: cmd.runId };
      case 'run.merge':
        await this.merge(cmd.runId, cmd.target);
        return { runId: cmd.runId };
      case 'run.pr':
        await this.openPr(cmd.runId, cmd.base);
        return { runId: cmd.runId };
      case 'run.prMerge':
        await this.mergePrOf(cmd.runId);
        return { runId: cmd.runId };
      case 'run.prFollowup':
        await this.prFollowup(cmd.runId, cmd.items, cmd.note);
        return { runId: cmd.runId };
      case 'run.updateBranch':
        await this.updateBranch(cmd.runId);
        return { runId: cmd.runId };
      case 'run.delete':
        await this.deleteRun(cmd.runId, cmd.deleteBranch);
        return { runId: cmd.runId };
    }
  }

  /** После перезапуска приложения: прогоны, оборванные посреди стадии, помечаются остановленными. */
  async recover(): Promise<void> {
    for (const s of this.store.list()) {
      // Агенты и тесты, пережившие аварийный выход приложения, не должны писать в worktree параллельно с повтором стадии.
      const orphans = [...this.store.readPids(s.id), ...this.store.readPids(`${s.id}:server`), ...this.store.readPids(`${s.id}:preview`)];
      if (orphans.length) {
        await Promise.all(orphans.map(killPid));
        this.store.writePids(s.id, []);
        this.store.writePids(`${s.id}:server`, []);
        this.store.writePids(`${s.id}:preview`, []);
      }
      if (s.status !== 'running' || s.missing) continue;
      const r = this.store.load(s.id);
      if (!r) continue;
      if (r.baseProbeStash) {
        // Приложение закрылось во время проверки тестов на исходном коде — возвращаем изменения прогона из stash.
        const sha = r.baseProbeStash;
        await this.tools(['git']).then((t) => new Git(t.git, this.opts.env).restoreStash(r.worktreePath, sha))
          .then(() => { r.baseProbeStash = undefined; })
          .catch(() => { r.message = `Изменения прогона остались в git stash (${sha.slice(0, 8)}) — верните их: git stash apply ${sha.slice(0, 8)}`; });
      }
      for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
      // Оборванная реализация — не вина исполнителя: попытку возвращаем.
      if (r.next === 'implement' && r.implAttemptsUsed > 0) r.implAttemptsUsed--;
      // Исполнитель продолжит свою сессию: говорим ему, что прошлая попытка оборвалась, а не «исправь замечания».
      if (r.next === 'implement' && !r.feedback && r.executorSession) {
        r.feedback = { source: 'system', text: 'Прошлая попытка оборвалась на середине: приложение PurpleFlow было закрыто. Продолжи с того места, где остановился: посмотри, что уже сделано (git status, отметки в tasks.md), и доделай задачу.' };
      }
      if (r.message?.startsWith('Изменения прогона остались в git stash')) {
        r.status = 'stopped';
      } else {
        // Прогон продолжится сам — в очереди, с учётом лимита одновременных прогонов.
        r.status = 'queued';
        r.message = 'Приложение было закрыто — прогон продолжится сам с текущей стадии.';
      }
      this.store.save(r);
    }
    void this.pump();
  }

  // ——— Запросы для UI ———

  listRuns(): RunSummary[] {
    return this.store.list();
  }

  getRun(id: string): RunFile | null {
    return this.store.load(id);
  }

  getLog(id: string): string {
    return this.store.readLog(id);
  }

  isDriving(id: string): boolean {
    return this.driving.has(id);
  }

  async getDiff(id: string): Promise<DiffFile[]> {
    const r = this.mustLoad(id);
    const tools = await this.tools(['git']);
    const git = new Git(tools.git, this.opts.env);
    const skip = this.diffSkip(r);
    // Завершённый прогон — дифф ветки прогона: рабочая копия могла уйти на другую ветку.
    if (r.status === 'finished') return git.diffCommits(r.projectPath, r.baseCommit, r.branch, skip);
    return git.diff(r.worktreePath, this.diffBase(r), skip);
  }

  /** Какие файлы не показывать в диффе: run.json, файлы окружения; в круге конфликтов — всё, кроме разрешённых. */
  diffSkip(r: RunFile): (p: string) => boolean {
    const env = new Set(this.envFilesOf(r));
    const only = r.status !== 'finished' && r.roundFiles?.length ? new Set(r.roundFiles) : null;
    return (p: string) => (p.startsWith('openspec/') && p.endsWith('/run.json')) || env.has(p) || Boolean(only && !only.has(p));
  }

  /** Изменённые файлы без содержимого — для счётчика на вкладке «Код». */
  async getChangedFiles(id: string): Promise<string[]> {
    const r = this.mustLoad(id);
    if (r.workspacePending || r.worktreeRemoved && r.status !== 'finished') return [];
    const git = new Git((await this.tools(['git'])).git, this.opts.env);
    const skip = this.diffSkip(r);
    const files = r.status === 'finished'
      ? await git.namesBetween(r.projectPath, r.baseCommit, r.branch)
      : await git.changedFiles(r.worktreePath, this.diffBase(r));
    return files.filter((f) => !skip(f));
  }

  /**
   * Удалить прогон. Сначала гасим всё живое (агент, сервер, предпросмотр), потом worktree,
   * по желанию — ветку, и данные в каталоге приложения. Рабочая копия проекта в режиме «ветка» не трогается.
   */
  async deleteRun(id: string, deleteBranch: boolean) {
    const r = this.store.load(id);
    const tools = await this.tools(['git']);
    const git = new Git(tools.git, this.opts.env);
    // Проверяем до удаления чего-либо: открытую в проекте ветку git не удалит.
    if (r && deleteBranch) {
      const cur = await git.currentBranch(r.projectPath).catch(() => null);
      if (cur === r.branch) throw new Error(`Проект сейчас на ветке ${r.branch} — переключитесь на другую (git checkout ${r.originalBranch ?? 'main'}), чтобы удалить её, или удалите прогон без ветки.`);
    }
    if (this.driving.has(id)) {
      this.stopping.add(id);
      await killGroup(id);
      // drive сам выйдет из цикла; ждём, пока отпустит прогон.
      for (let i = 0; i < 100 && this.driving.has(id); i++) await new Promise((res) => setTimeout(res, 100));
    }
    await killGroup(id);
    await killGroup(`${id}:server`);
    await killGroup(`${id}:manager`);
    await this.stopPreview(id);
    if (r) {
      if (r.workspace !== 'branch' && fs.existsSync(r.worktreePath)) await git.removeWorktree(r.projectPath, r.worktreePath).catch(() => undefined);
      if (deleteBranch) await git.deleteBranch(r.projectPath, r.branch).catch(() => undefined);
    }
    for (const dir of [this.attachmentsDir(id), path.join(this.opts.dataDir, 'visual', id)]) fs.rmSync(dir, { recursive: true, force: true });
    this.store.forget(id);
    this.emit({ type: 'run.deleted', runId: id });
    void this.pump();
  }

  // ——— Хранилище: сколько места занимают данные и что можно почистить ———

  runsWithFiles(): RunFile[] {
    return this.store.list().map((s) => this.store.load(s.id)).filter((r): r is RunFile => Boolean(r));
  }

  async getStorage(): Promise<StorageItem[]> {
    const runs = this.runsWithFiles();
    const wtRoot = this.store.worktreesDir();
    const own = (r: RunFile) => r.workspace !== 'branch' && !r.worktreeRemoved && fs.existsSync(r.worktreePath) && r.worktreePath.startsWith(wtRoot);
    const ended = (r: RunFile) => r.status === 'finished' || r.status === 'cancelled';
    const done = runs.filter((r) => own(r) && ended(r));
    const active = runs.filter((r) => own(r) && !ended(r));
    const known = new Set(runs.map((r) => path.resolve(r.worktreePath)));
    const orphan = subdirs(wtRoot).filter((d) => !known.has(path.resolve(d)) && !path.basename(d).startsWith('merge-'));
    const visualRoot = path.join(this.opts.dataDir, 'visual');
    const leftovers = browserLeftovers(visualRoot);
    const shots = screenshots(visualRoot);
    const history = ['logs', 'runs', 'attachments'].map((d) => path.join(this.opts.dataDir, d));
    return [
      { id: 'worktrees-done', title: 'Рабочие копии завершённых прогонов', hint: 'Worktree с зависимостями. Ветки с результатом, история, дифф и план остаются — пропадёт только ручной запуск во вкладке «Браузер».', bytes: await sizeOfAll(done.map((r) => r.worktreePath)), count: done.length, clean: 'Удалить' },
      { id: 'worktrees-active', title: 'Рабочие копии незавершённых прогонов', hint: 'Нужны, чтобы продолжить прогон. Удаляются вместе с прогоном.', bytes: await sizeOfAll(active.map((r) => r.worktreePath)), count: active.length },
      { id: 'worktrees-orphan', title: 'Брошенные рабочие копии', hint: 'Остались от удалённых или потерянных прогонов — ни к чему не привязаны.', bytes: await sizeOfAll(orphan), count: orphan.length, clean: 'Удалить' },
      { id: 'browser', title: 'Служебные файлы браузера', hint: 'Профили Chrome и кэш Playwright после визуальных проверок. Скриншоты не трогаются.', bytes: await sizeOfAll(leftovers), count: leftovers.length, clean: 'Удалить' },
      { id: 'shots', title: 'Скриншоты визуальных проверок', hint: 'Пропадут из деталей стадии «Визуальная проверка» у всех прогонов.', bytes: await sizeOfAll(shots), count: shots.length, clean: 'Удалить' },
      { id: 'history', title: 'История прогонов', hint: 'Логи, run.json и изображения к задачам. Удаляются вместе с прогоном.', bytes: await sizeOfAll(history), count: runs.length },
    ];
  }

  /** Очистить категорию; возвращает, сколько байт освободили. */
  async cleanStorage(id: StorageItem['id']): Promise<number> {
    const before = (await this.getStorage()).find((x) => x.id === id)?.bytes ?? 0;
    const tools = await this.tools(['git']);
    const git = new Git(tools.git, this.opts.env);
    const wtRoot = this.store.worktreesDir();
    if (id === 'worktrees-done') {
      for (const r of this.runsWithFiles()) {
        if (r.workspace === 'branch' || r.worktreeRemoved || !(r.status === 'finished' || r.status === 'cancelled')) continue;
        if (!r.worktreePath.startsWith(wtRoot) || this.driving.has(r.id)) continue;
        await this.stopPreview(r.id);
        // Сначала помечаем: дальше run.json пишется только в данные приложения и worktree не пересоздаётся.
        r.worktreeRemoved = true;
        this.save(r);
        await git.removeWorktree(r.projectPath, r.worktreePath).catch(() => fs.rmSync(r.worktreePath, { recursive: true, force: true }));
      }
    } else if (id === 'worktrees-orphan') {
      const known = new Set(this.runsWithFiles().map((r) => path.resolve(r.worktreePath)));
      for (const d of subdirs(wtRoot)) {
        if (known.has(path.resolve(d)) || path.basename(d).startsWith('merge-')) continue;
        // Worktree знает свой репозиторий по файлу .git — снимаем регистрацию там же.
        let gitdir: string | null = null;
        try {
          gitdir = fs.readFileSync(path.join(d, '.git'), 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim() ?? null;
        } catch { /* не worktree */ }
        const repo = gitdir ? path.resolve(gitdir, '..', '..', '..') : null;
        if (repo && fs.existsSync(repo)) await git.removeWorktree(repo, d).catch(() => undefined);
        fs.rmSync(d, { recursive: true, force: true });
      }
    } else if (id === 'browser') {
      for (const p of browserLeftovers(path.join(this.opts.dataDir, 'visual'))) fs.rmSync(p, { recursive: true, force: true });
    } else if (id === 'shots') {
      for (const p of screenshots(path.join(this.opts.dataDir, 'visual'))) fs.rmSync(p, { force: true });
    }
    const after = (await this.getStorage()).find((x) => x.id === id)?.bytes ?? 0;
    return Math.max(0, before - after);
  }

  // ——— Pull Request на GitHub ———

  ghBin() : string | null { return ghBin(this); }

  prReady(id: string) : Promise<string | null> { return prReady(this, id); }

  openPr(id: string, base: string) { return openPr(this, id, base); }

  prBody(r: RunFile) : Promise<string> { return prBody(this, r); }

  getPrStatus(id: string) : Promise<PrStatus | null> { return getPrStatus(this, id); }

  getPrDetails(id: string) : Promise<PrDetails | null> { return getPrDetails(this, id); }

  prFollowup(id: string, items: PrFollowupItem[], note?: string) { return prFollowup(this, id, items, note); }

  reopenWorkspace(r: RunFile) : Promise<{ git: Git; pulled: 'updated' | 'same' | 'diverged' | 'no-remote' }> { return reopenWorkspace(this, r); }

  updateBranch(id: string) { return updateBranch(this, id); }

  diffBase(run: RunFile) : string { return diffBase(this, run); }

  mergePrOf(id: string) { return mergePrOf(this, id); }

  listBranches(id: string) : Promise<{ branches: string[]; current: string | null; suggested: string | null }> { return listBranches(this, id); }

  merge(id: string, target: string) { return merge(this, id, target); }

  /** proposal.md, tasks.md и дельты спецификаций — для гейта 1 и ревью. */
  async getChangeDocs(id: string): Promise<{ proposal: string; tasks: string; design: string; specs: { path: string; content: string }[] }> {
    const r = this.mustLoad(id);
    const dir = r.archivedPath ? path.dirname(r.archivedPath) : path.join(r.worktreePath, 'openspec', 'changes', r.changeId);
    if (!fs.existsSync(dir) && r.status === 'finished') {
      // Режим «ветка» после переключения ветки: читаем документы из ветки прогона.
      const tools = await this.tools(['git']);
      const git = new Git(tools.git, this.opts.env);
      const rel = path.relative(r.worktreePath, dir).split(path.sep).join('/');
      const at = (f: string) => git.show(r.projectPath, r.branch, `${rel}/${f}`);
      const specFiles = (await git.listAt(r.projectPath, r.branch, `${rel}/specs`)).filter((f) => f.endsWith('.md')).sort();
      return {
        proposal: await at('proposal.md'),
        tasks: await at('tasks.md'),
        design: await at('design.md'),
        specs: await Promise.all(specFiles.map(async (f) => ({ path: f.slice(rel.length + 1), content: await git.show(r.projectPath, r.branch, f) }))),
      };
    }
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        return '';
      }
    };
    const specs: { path: string; content: string }[] = [];
    const specsDir = path.join(dir, 'specs');
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const name of fs.readdirSync(d).sort()) {
        const full = path.join(d, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.md')) specs.push({ path: path.relative(dir, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
      }
    };
    walk(specsDir);
    return { proposal: read('proposal.md'), tasks: read('tasks.md'), design: read('design.md'), specs };
  }

  async detectTools(): Promise<Record<ToolName, ToolInfo>> {
    return detectTools(this.opts.env, this.opts.getSettings().toolPaths);
  }

  /** Тестовый запрос каждым агентом с текущими настройками прокси и моделей. */
  async testConnection(): Promise<ConnectionCheck[]> {
    const s = this.opts.getSettings();
    const found = await detectTools(this.opts.env, s.toolPaths);
    const present = (['claude', 'codex'] as const).filter((a) => found[a].path && !found[a].error);
    if (!present.length) throw new Error('Не найдены ни claude, ни codex. Укажите пути в настройках.');
    const tools = { claude: found.claude.path!, codex: found.codex.path! };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psflow-check-'));
    const proxy = s.proxy.baseUrl ? s.proxy : undefined;
    const prompt = 'Это проверка подключения. Ответь ровно одним словом: готово';
    const one = async (agent: 'claude' | 'codex'): Promise<ConnectionCheck> => {
      const t0 = Date.now();
      // Модель — из первой роли, которую выполняет этот агент.
      const agents = { ...DEFAULT_AGENTS, ...s.agents };
      const role = (['planner', 'executor', 'reviewer'] as Role[]).find((x) => agents[x] === agent);
      const model = role ? s.models[role] : '';
      const base = { bin: tools[agent], cwd: dir, env: this.opts.env, prompt, model, timeoutMs: 120_000, group: `check-${agent}`, onOutput: () => {}, proxy, claudeAuth: s.claudeAuth };
      const r = agent === 'claude' ? await this.claude(base) : await this.codex({ ...base, sandbox: 'read-only' });
      return { agent, ok: r.ok, model: model || 'по умолчанию', durationMs: Date.now() - t0, reply: r.text.trim().slice(0, 200), error: r.error };
    };
    try {
      return await Promise.all(present.map(one));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ——— Жизненный цикл ———

  async start(input: StartRunInput): Promise<string> {
    const s = this.opts.getSettings();
    // Нужны только агенты, выбранные для ролей: на машине может стоять один claude или один codex.
    const roles: Record<Role, AgentKind> = { planner: s.agents?.planner ?? DEFAULT_AGENTS.planner, executor: s.agents?.executor ?? DEFAULT_AGENTS.executor, reviewer: s.agents?.reviewer ?? DEFAULT_AGENTS.reviewer };
    const visualAgent = s.agents?.visual ?? 'claude';
    const tools = await this.tools(['git', 'openspec', ...new Set(Object.values(roles))]);
    const git = new Git(tools.git, this.opts.env);
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
    const branch = `psflow/${changeId}`;
    const workspace = input.workspace ?? 'worktree';
    if (workspace === 'branch') {
      // В режиме «ветка» прогон занимает рабочую копию проекта целиком — второй в том же проекте ей бы помешал.
      const busy = this.runsWithFiles().find((r) => r.workspace === 'branch' && path.resolve(r.projectPath) === path.resolve(repo) && ['running', 'waiting', 'queued'].includes(r.status));
      if (busy) throw new Error(`В режиме «Ветка» в проекте уже идёт «${busy.title}». Дождитесь его или выберите отдельную копию (worktree).`);
    }
    const worktreePath = workspace === 'branch' ? repo : path.join(this.store.worktreesDir(), `${path.basename(repo)}-${changeId}`);
    const mode = input.mode ?? 'task';
    // Агента визуальной проверки на машине может не быть — тогда проверка выключается, а не роняет прогон.
    const visual = Boolean(input.visual && input.runCommand?.trim() && input.appUrl?.trim() && (await this.hasTool(visualAgent)));
    const queued = this.activeCount() >= this.maxParallel();

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const carried = (input.attachmentPaths ?? []).filter((p) => fs.existsSync(p)).map((p) => ({ name: path.basename(p).replace(/^\d+-/, ''), data: fs.readFileSync(p) }));
    const attachments = this.saveAttachments(id, [...carried, ...(input.attachments ?? [])]);
    const run: RunFile = {
      version: 1,
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
      this.save(run);
      this.log(run, c.dim(`PurpleFlow · ${run.changeId}\nв очереди: одновременно идут ${this.activeCount()} из ${this.maxParallel()} — начнётся, когда освободится место\n`));
      return run.id;
    }
    try {
      await this.prepareWorkspace(run);
    } catch (e) {
      // Рабочую копию создать не удалось (грязная копия, ветка уже есть…) — прогона нет, ошибка уходит в окно.
      this.store.forget(run.id);
      throw e;
    }
    void this.drive(run);
    return run.id;
  }

  prepareWorkspace(run: RunFile) { return prepareWorkspace(this, run); }

  // ——— Очередь: сколько прогонов агенты ведут одновременно ———

  /** Настройки поменялись (например, лимит одновременных прогонов) — может, кого-то пора запустить из очереди. */
  settingsChanged() {
    void this.pump();
  }

  maxParallel(): number {
    return Math.max(1, Math.min(8, this.opts.getSettings().maxParallel ?? 2));
  }

  /** Прогоны, в которых сейчас работают агенты. Ожидание решения человека место не занимает. */
  activeCount(): number {
    return this.store.list().filter((r) => r.status === 'running').length;
  }

  /** Запустить из очереди столько прогонов, сколько есть свободных мест (старые — первыми). */
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.activeCount() < this.maxParallel()) {
        const next = this.store.list().filter((r) => r.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!next) break;
        const run = this.store.load(next.id);
        if (!run) break;
        await this.launchQueued(run);
      }
    } finally {
      this.pumping = false;
    }
  }

  pumping = false;

  async launchQueued(run: RunFile) {
    run.status = 'running';
    run.message = undefined;
    this.save(run);
    try {
      if (run.workspacePending) await this.prepareWorkspace(run);
      // Продолжение после перезапуска приложения: в режиме «ветка» проект могли переключить на другую ветку.
      else await this.ensureOnBranch(run);
    } catch (e) {
      run.status = 'stopped';
      run.message = `Не удалось начать прогон: ${(e as Error).message}`;
      this.save(run);
      this.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message: run.message });
      return;
    }
    void this.drive(run);
  }

  async resume(id: string) {
    if (this.driving.has(id)) return;
    const r = this.mustLoad(id);
    if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
    // Из очереди или не начавшийся — «Запустить сейчас», без оглядки на лимит одновременных прогонов.
    if (r.status === 'queued' || r.workspacePending) return this.launchQueued(r);
    await this.ensureOnBranch(r);
    r.message = undefined;
    if (r.next === 'plan') r.planRetries = 0;
    if (isGate(r.next)) return this.waitGate(r, r.next as GateId, this.gateMessage(r));
    r.status = 'running';
    this.save(r);
    void this.drive(r);
  }

  /** Режим «ветка»: продолжать можно, только если проект всё ещё на ветке прогона. */
  async ensureOnBranch(r: RunFile) {
    if (r.workspace !== 'branch') return;
    const tools = await this.tools(['git']);
    const cur = await new Git(tools.git, this.opts.env).currentBranch(r.projectPath);
    if (cur !== r.branch) throw new Error(`Проект сейчас на ветке ${cur ?? 'detached HEAD'}. Переключитесь на ${r.branch} (git checkout ${r.branch}) и продолжите.`);
  }

  // ——— Ручная проверка: приложение из ветки прогона ———

  previews = new Map<string, PreviewState>();

  getPreview(id: string): PreviewState {
    return this.previews.get(id) ?? { status: 'idle' };
  }

  setPreview(id: string, state: PreviewState) {
    if (state.status === 'idle') this.previews.delete(id);
    else this.previews.set(id, state);
    this.emit({ type: 'preview.state', runId: id, state });
  }

  /** Поднять приложение в рабочей копии прогона на свободном порту (команды «Запуск приложения» и «Адрес»). */
  async startPreview(id: string): Promise<PreviewState> {
    // Чат — приложение из папки проекта чата.
    if (id.startsWith('chat-')) return startChatPreview(this, id);
    const r = this.mustLoad(id);
    const cur = this.previews.get(id);
    if (cur && (cur.status === 'starting' || cur.status === 'ready')) return cur;
    const cfg = this.getProjectConfig(r.projectPath);
    const runCommand = cfg?.runCommand || r.runCommand;
    const appUrl = cfg?.appUrl || r.appUrl;
    if (!runCommand || !appUrl) throw new Error('Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты»).');
    if (!fs.existsSync(r.worktreePath)) throw new Error(`Рабочая копия прогона не найдена: ${r.worktreePath}`);
    if (r.workspace === 'branch') await this.ensureOnBranch(r);
    this.copyEnvFiles(r);
    return this.launchPreview(id, { repo: r.projectPath, cwd: r.worktreePath, runCommand, appUrl });
  }

  /** Запуск приложения для ручной проверки: подготовка, сервер на свободном порту, ожидание адреса. */
  async launchPreview(id: string, o: { repo: string; cwd: string; runCommand: string; appUrl: string }): Promise<PreviewState> {
    const { repo, cwd, runCommand, appUrl } = o;
    const { port, url, command } = await expandPorts(appUrl, runCommand);
    const group = `${id}:preview`;
    let output = '';
    let exited: number | null | undefined;
    const tail = (t: string) => {
      output = (output + t).slice(-4000);
    };
    this.setPreview(id, { status: 'starting', url, command });
    try {
      await prepareApp(this, { repo, cwd, group, onOutput: tail });
    } catch (e) {
      const state: PreviewState = { status: 'failed', url, command, output, error: (e as Error).message.split('\n')[0] };
      this.setPreview(id, state);
      return state;
    }
    // Остановили, пока шла подготовка.
    if (this.previews.get(id)?.url !== url || this.previews.get(id)?.status !== 'starting') return this.getPreview(id);
    const server = runProc(command, [], {
      cwd,
      env: { ...this.opts.env, ...portEnv(runCommand, port), BROWSER: 'none' },
      shell: true,
      group,
      onStdout: tail,
      onStderr: tail,
    });
    void server.then((res) => {
      exited = res.code;
      const now = this.previews.get(id);
      // Сервер упал сам (не по «Остановить») — показываем вывод.
      if (now && now.url === url && (now.status === 'ready' || now.status === 'starting')) {
        this.setPreview(id, { status: 'failed', url, command, error: `Приложение завершилось с кодом ${res.code}`, output });
      }
    });
    const ready = await waitForUrl(url, 120_000, () => exited !== undefined || this.previews.get(id)?.url !== url);
    const now = this.previews.get(id);
    if (!now || now.url !== url) return this.getPreview(id); // остановили, пока поднималось
    if (!ready) {
      await killGroup(group);
      const state: PreviewState = {
        status: 'failed', url, command, output,
        error: exited !== undefined ? `Приложение завершилось с кодом ${exited}, не открыв ${url}` : `За 2 минуты приложение не ответило на ${url}`,
      };
      this.setPreview(id, state);
      return state;
    }
    const state: PreviewState = { status: 'ready', url, command };
    this.setPreview(id, state);
    return state;
  }

  async stopPreview(id: string): Promise<void> {
    if (!this.previews.has(id)) return;
    this.setPreview(id, { status: 'idle' });
    await killGroup(`${id}:preview`);
  }

  envFilesOf(run: RunFile) : string[] { return envFilesOf(this, run); }

  copyEnvFiles(run: RunFile) { return copyEnvFiles(this, run); }

  cloneDeps(run: RunFile) { return cloneDeps(this, run); }

  async stop(id: string) {
    const r = this.store.load(id);
    if (!r) return;
    if (r.status === 'queued') {
      r.status = 'stopped';
      r.message = 'Снят с очереди. «Продолжить» запустит его сразу.';
      this.save(r);
      this.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message });
      return;
    }
    await killGroup(`${id}:server`);
    await this.stopPreview(id);
    if (this.driving.has(id)) {
      this.stopping.add(id);
      await killGroup(id);
      return; // цикл drive сам зафиксирует остановку
    }
    await killGroup(id);
    if (r.status === 'running' || r.status === 'waiting') {
      r.status = 'stopped';
      r.message = 'Остановлено пользователем';
      this.save(r);
      this.emit({ type: 'run.finished', runId: id, status: 'stopped', message: r.message });
    }
  }

  /** Повторить визуальную проверку: команда запуска и URL берутся из настроек проекта — их могли поправить. */
  async rerunVisual(id: string) {
    if (this.driving.has(id)) throw new Error('Прогон сейчас работает — дождитесь решения или остановите его');
    const r = this.mustLoad(id);
    if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
    if (!r.attempts.some((a) => a.stage === 'implement' && a.status === 'done')) throw new Error('Реализации ещё не было — проверять нечего');
    const cfg = this.getProjectConfig(r.projectPath);
    const runCommand = cfg?.runCommand?.trim() || r.runCommand;
    const appUrl = cfg?.appUrl?.trim() || r.appUrl;
    if (!runCommand || !appUrl) throw new Error('Нет команды запуска и адреса приложения — задайте их в настройках проекта');
    await this.stopPreview(id);
    await this.ensureOnBranch(r);
    r.runCommand = runCommand;
    r.appUrl = appUrl;
    r.visual = true;
    const now = new Date().toISOString();
    for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'done', endedAt: now, summary: a.summary ?? 'Перезапуск визуальной проверки' });
    this.log(r, c.violet('↻ визуальная проверка заново') + '\n');
    r.message = undefined;
    r.next = 'visual';
    r.status = 'running';
    this.save(r);
    void this.drive(r);
  }

  /** Человек решил не ждать: текущая реализация или проверки останавливаются, проверки считаются пропущенными. */
  async skipChecks(id: string) {
    const before = this.mustLoad(id);
    if (before.next !== 'implement' && before.next !== 'tests' && before.next !== 'limit') throw new Error('Пропустить проверки можно только на реализации или проверках');
    if (!before.attempts.some((a) => a.stage === 'implement' && a.status === 'done')) throw new Error('Реализация ещё ни разу не завершилась — проверять нечего');
    await this.halt(id);
    const r = this.mustLoad(id);
    const now = new Date().toISOString();
    for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: now });
    const n = r.attempts.filter((a) => a.stage === 'tests').length + 1;
    r.attempts.push({ stage: 'tests', attempt: n, startedAt: now, endedAt: now, status: 'done', summary: 'Пропущены человеком' });
    r.tests.push({ at: now, command: '', passed: true, exitCode: 0, durationMs: 0, output: 'Проверки пропущены человеком.', checks: [] });
    this.log(r, c.amber('↷ проверки пропущены человеком — дальше ревью') + '\n');
    r.feedback = undefined;
    r.message = undefined;
    r.mergeOnly = undefined;
    r.next = afterChecks(r, await this.needsReview(r));
    r.status = 'running';
    this.save(r);
    void this.drive(r);
  }

  // ——— Управление на ходу и менеджер прогона ———

  /** Прогоны, по которым менеджер сейчас готовит ответ. */
  managerBusy = new Set<string>();
  /** Чаты, в которых агент сейчас отвечает. */
  chatBusy = new Set<string>();
  listChats(): ChatSummary[] { return listChats(this); }
  getChat(id: string) { return getChat(this, id); }
  createChat(o: Parameters<typeof createChat>[1]) { return createChat(this, o); }
  updateChat(id: string, patch: Parameters<typeof updateChat>[2]) { return updateChat(this, id, patch); }
  deleteChat(id: string) { return deleteChat(this, id); }
  /** Ход идёт в фоне: ответ приходит событиями chat.updated. */
  async sendChat(id: string, text: string, files?: { name: string; data: Uint8Array }[]): Promise<void> {
    const p = sendChat(this, id, text, files);
    // Ошибки до начала хода (занят, пустое сообщение) — сразу вызывающему; дальше всё в сообщении ответа.
    await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
    p.catch(() => {});
  }
  stopChat(id: string) { return stopChat(this, id); }
  chatToTask(id: string) { return chatToTask(this, id); }
  getChatDiff(id: string) { return chatDiff(this, id); }
  getChatChangedFiles(id: string) { return chatChangedFiles(this, id); }

  control(id: string, action: ControlAction) { return control(this, id, action); }

  getManagerChat(id: string): { messages: ManagerMessage[]; thinking: boolean } { return { messages: getManagerChat(this, id), thinking: this.managerBusy.has(id) }; }

  askManager(id: string, text: string): Promise<ManagerMessage[]> { return askManager(this, id, text); }

  resolveManagerAction(id: string, messageId: string, apply: boolean): Promise<ManagerMessage[]> { return resolveManagerAction(this, id, messageId, apply); }

  /** Остановить крутящийся цикл стадий и дождаться, пока он отпустит прогон, — перед тем как самим поменять маршрут. */
  async halt(id: string) {
    if (!this.driving.has(id)) return;
    await this.stop(id);
    for (let i = 0; i < 100 && this.driving.has(id); i++) await new Promise((r) => setTimeout(r, 200));
    if (this.driving.has(id)) throw new Error('Не удалось остановить текущую стадию');
  }

  async decide(id: string, decision: 'approve' | 'reject' | 'cancel' | 'accept' | 'fix', comment?: string, lineComments?: LineComment[]) {
    const r = this.mustLoad(id);
    // Решение принято — сервер ручной проверки гасим: дальше коммит или новая попытка в той же рабочей копии.
    await this.stopPreview(id);
    if (!isGate(r.next) || (r.status !== 'waiting' && r.status !== 'stopped')) throw new Error('Прогон не ждёт решения на гейте');
    const gate = r.next as GateId;
    r.gates.push({ gate, at: new Date().toISOString(), decision, comment: comment?.trim() || undefined, lineComments: lineComments?.length ? lineComments : undefined });
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
      this.log(r, c.violet('→ быстрая правка с приёмки: реализация → проверки → снова приёмка') + '\n');
      r.status = 'running';
      this.save(r);
      void this.drive(r);
      return;
    }

    if (decision === 'accept') {
      if (gate !== 'limit') throw new Error('Принять как есть можно только после исчерпания попыток');
      // Человек берёт ответственность на себя: красные проверки или замечания ревью — дальше без новых попыток.
      // Визуальная проверка ещё не было — идём в неё (скриншоты пригодятся на приёмке), иначе — сразу на приёмку.
      const toVisual = acceptTarget(r) === 'visual';
      if (gateAttempt) gateAttempt.summary = toVisual ? 'Дальше как есть — к визуальной проверке' : 'Принято как есть';
      this.log(r, c.amber(`→ человек принял результат как есть — ${toVisual ? 'к визуальной проверке' : 'к приёмке'}`) + '\n');
      r.feedback = undefined;
      r.next = toVisual ? 'visual' : 'gate2';
      r.status = 'running';
      this.save(r);
      void this.drive(r);
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
      this.save(r);
      this.emit({ type: 'run.finished', runId: id, status: r.status, message: r.message });
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
        r.feedback = r.replanNote ? human(`План обновлён: человек вернул задачу на план с реализации — «${r.replanNote}». Сверься с обновлённым proposal и tasks.md и продолжай по ним; то, что новому плану противоречит, переделай.`) : undefined;
        r.replanNote = undefined;
        if (modeOf(r) === 'epic') r.phase = 1;
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
      r.feedback = { source: r.feedback?.source ?? 'human', text: [prev, comment?.trim() ? `Комментарий человека:\n${comment.trim()}` : ''].filter(Boolean).join('\n\n'), lineComments };
    }
    r.status = 'running';
    this.save(r);
    void this.drive(r);
  }

  // ——— Цикл стадий ———

  async drive(run: RunFile) {
    if (this.driving.has(run.id)) return;
    this.driving.add(run.id);
    this.stopping.delete(run.id);
    // Продолжение старого прогона: файлов окружения в worktree могло ещё не быть.
    this.copyEnvFiles(run);
    try {
      while (run.status === 'running') {
        if (isGate(run.next)) {
          this.waitGate(run, run.next as GateId, this.gateMessage(run));
          break;
        }
        if (applyPending(this, run)) break;
        switch (run.next) {
          case 'baseline': await this.stageBaseline(run); break;
          case 'visual': await this.stageVisual(run); break;
          case 'clarify': await this.stageClarify(run); break;
          case 'plan': await this.stagePlan(run); break;
          case 'implement': await this.stageImplement(run); break;
          case 'tests': await this.stageTests(run); break;
          case 'review': await this.stageReview(run); break;
          case 'finish': await this.stageFinish(run); break;
        }
      }
    } catch (e) {
      if (e instanceof StopSignal || this.stopping.has(run.id)) {
        this.markStopped(run, 'Остановлено пользователем');
      } else {
        this.fail(run, (e as Error).message || String(e));
      }
    } finally {
      this.driving.delete(run.id);
      this.stopping.delete(run.id);
      // Место освободилось (гейт, конец, ошибка) — следующий из очереди.
      void this.pump();
    }
  }

  // ——— Уточнение задачи до плана ———

  /** Задача с ответами на вопросы уточнения — её видят все стадии. */
  taskText(run: RunFile): string {
    const a = run.clarify?.answers?.filter((x) => x.a.trim());
    if (!a?.length) return run.task;
    return `${run.task}\n\nУточнения от человека:\n${a.map((x) => `- ${x.q} — ${x.a}`).join('\n')}`;
  }

  stageClarify(run: RunFile) { return stageClarify(this, run); }

  answer(id: string, answers: { q: string; a: string }[]) { return answer(this, id, answers); }

  // ——— Знания о проекте: профиль и уроки прошлых прогонов ———

  knowledgeOf(repo: string) : ProjectKnowledge { return knowledgeOf(this, repo); }

  updateKnowledge(repo: string, fn: (k: ProjectKnowledge) => ProjectKnowledge) { return updateKnowledge(this, repo, fn); }

  knowledgeBlock(run: RunFile) : string { return knowledgeBlock(this, run); }

  relatedState(run: RunFile) { return relatedState(this, run.projectPath); }

  checkRelatedUntouched(run: RunFile, before: Map<string, string>) { return checkRelatedUntouched(this, run, before); }

  profileFor(repo: string, cwd: string, onOutput: (t: string) => void, group: string) : Promise<AgentResult> { return profileFor(this, repo, cwd, onOutput, group); }

  ensureProfile(run: RunFile, attempt: StageAttempt) { return ensureProfile(this, run, attempt); }

  refreshProfile(repo: string) : Promise<ProjectKnowledge> { return refreshProfile(this, repo); }

  saveKnowledge(repo: string, k: ProjectKnowledge) : ProjectKnowledge { return saveKnowledge(this, repo, k); }

  getKnowledge(repo: string) : ProjectKnowledge { return getKnowledge(this, repo); }

  summaryContext(run: RunFile) : string { return summaryContext(this, run); }

  summarizeChanges(id: string) { return summarizeChanges(this, id); }

  learn(run: RunFile) { return learn(this, run); }

  stagePlan(run: RunFile) { return stagePlan(this, run); }

  mapFilesToPlan(id: string) { return mapFilesToPlan(this, id); }

  startFilesBlock(run: RunFile) : Promise<string> { return startFilesBlock(this, run); }

  stageImplement(run: RunFile) { return stageImplement(this, run); }

  dropArtifacts(run: RunFile) { return dropArtifacts(this, run); }

  runChecks(run: RunFile, testCommand = run.testCommand) : Promise<{ result: TestResult; failed: CheckResult[] }> { return runChecks(this, run, testCommand); }

  runCheck(run: RunFile, kind: CheckResult['kind'], command: string, timeoutMin: number, note = '') : Promise<CheckResult> { return runCheck(this, run, kind, command, timeoutMin, note); }

  probeTests(run: RunFile, check: CheckResult, beforeStash?: Promise<unknown> | null) : Promise<CheckResult> { return probeTests(this, run, check, beforeStash); }

  checksFeedback(failed: CheckResult[], base?: CheckResult[]) : string { return checksFeedback(this, failed, base); }

  captureBaseChecks(run: RunFile) { return captureBaseChecks(this, run); }

  compareWithBase(run: RunFile, result: TestResult) : { result: TestResult; failed: CheckResult[] } { return compareWithBase(this, run, result); }

  stageTests(run: RunFile) { return stageTests(this, run); }

  stageBaseline(run: RunFile) { return stageBaseline(this, run); }

  needsReview(run: RunFile) : Promise<boolean> { return needsReview(this, run); }

  listProjects() : ProjectListItem[] { return listProjects(this); }

  nextPartDraft(id: string) : Promise<NextPartDraft | null> { return nextPartDraft(this, id); }

  envChecks = new Set<string>();

  checkEnvironment(repo: string) : Promise<EnvCheck> { return checkEnvironment(this, repo); }

  cleanWorkingCopy(repo: string, how: 'stash' | 'discard') : Promise<{ files: number }> { return cleanWorkingCopy(this, repo, how); }

  projectOverview(repo: string) : Promise<ProjectOverview> { return projectOverview(this, repo); }

  projectStats(repo: string) : ProjectStats { return projectStats(this, repo); }

  projectBranches(repo: string, fetch = false) : Promise<ProjectBranches> { return projectBranches(this, repo, fetch); }

  forgetProject(repo: string) : void { return forgetProject(this, repo); }

  getProjectConfig(repo: string) : ProjectConfig | null { return getProjectConfig(this, repo); }

  saveProjectConfig(repo: string, cfg: Omit<ProjectConfig, 'updatedAt'>) : ProjectConfig { return saveProjectConfig(this, repo, cfg); }

  detectCommandsAI(dir: string) : Promise<AiCommands> { return detectCommandsAI(this, dir); }

  suggestMode(task: string) : Promise<ModeSuggestion> { return suggestMode(this, task); }

  visualDir(run: RunFile, attempt: number) : string { return visualDir(this, run, attempt); }

  stageVisual(run: RunFile) { return stageVisual(this, run); }

  startLiveBrowser(run: RunFile, dir: string, url: string, group: string, session: string) : Promise<{ cast: Screencast } | null> { return startLiveBrowser(this, run, dir, url, group, session); }

  getVisualShot(id: string, file: string) : string | null { return getVisualShot(this, id, file); }

  previousReviewBlock(run: RunFile) : string { return previousReviewBlock(this, run); }

  stageReview(run: RunFile) { return stageReview(this, run); }

  reviewPass(run: RunFile, quiet = false) : Promise<{ review: ReviewResult; log: string }> { return reviewPass(this, run, quiet); }

  verifyBlocking(run: RunFile, attempt: StageAttempt, items: ReviewItem[], proposal: string, out: (t: string) => void) : Promise<{ blocking: ReviewItem[]; demoted: ReviewItem[] }> { return verifyBlocking(this, run, attempt, items, proposal, out); }

  reviewFeedback(review: ReviewResult) : string { return reviewFeedback(this, review); }

  stageFinish(run: RunFile) { return stageFinish(this, run); }

  // ——— Вспомогательное ———

  nextImplementOrLimit(run: RunFile, limitMessage: string) {
    if (run.implAttemptsUsed < run.implAttemptsLimit) {
      run.next = 'implement';
      this.save(run);
      return;
    }
    run.next = 'limit';
    run.message = `${limitMessage} Дать ещё одну попытку или остановить прогон?`;
    this.save(run);
  }

  gateMessage(run: RunFile): string | undefined {
    if (run.next === 'gate0') return `У планировщика ${run.clarify?.questions.length ?? 0} ${(run.clarify?.questions.length ?? 0) === 1 ? 'вопрос' : 'вопроса'} по задаче — ответьте, чтобы план не строился на догадках.`;
    if (run.next === 'limit') return run.message ?? 'Попытки реализации исчерпаны. Дать ещё одну попытку?';
    if (run.next === 'gate1' && modeOf(run) === 'bug') return 'Баг воспроизведён падающим тестом. Причина и план исправления верны?';
    if (run.next === 'gate1' && modeOf(run) === 'epic') return 'Проверьте design.md, этапы в tasks.md и proposal. Принять дизайн?';
    if (run.next === 'gate1' && run.nextParts) return 'Задача большая — планировщик взял в этот план первую часть, остальные перечислены в разделе «Next Parts» в proposal. Запустите их следующими задачами после этой. Принять план первой части?';
    if (run.next === 'gate1') return 'Проверьте proposal и tasks. Принять, вернуть с комментарием или отменить?';
    if (run.next === 'gate2') return 'Посмотрите дифф и замечания ревью. Принять или вернуть на доработку?';
    return undefined;
  }

  waitGate(run: RunFile, gate: GateId, message?: string) {
    const open = run.attempts.find((a) => a.stage === gate && a.status === 'running');
    if (!open) this.begin(run, gate);
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
    this.save(run);
    this.log(run, c.amber(`◆ ${STAGE_TITLES[gate]}: ждём решения человека`) + '\n');
    this.emit({ type: 'gate.waiting', runId: run.id, gate, message });
    if (gate === 'gate2') {
      void this.summarizeChanges(run.id).catch(() => undefined);
      void this.mapFilesToPlan(run.id).catch(() => undefined);
    }
    if (run.autopilot) void this.autopilotGate(run, gate);
  }

  /**
   * Автопилот: план без вопросов к человеку принимается сам, при исчерпанных попытках — одна попытка сама.
   * Вопросы уточнения, разбивка задачи на части и приёмка — всегда за человеком.
   */
  async autopilotGate(run: RunFile, gate: GateId) {
    if (gate === 'gate1') {
      if (run.replanNote) {
        this.log(run, c.amber('Автопилот: план переписан после возврата с реализации — проверьте его сами.') + '\n');
        return;
      }
      const docs = await this.getChangeDocs(run.id).catch(() => null);
      if (docs && /^##\s+Next Parts/m.test(docs.proposal)) {
        this.log(run, c.amber('Автопилот: планировщик предлагает разбить задачу на части — план ждёт вашего решения.') + '\n');
        return;
      }
      this.log(run, c.violet('Автопилот: план принят без остановки.') + '\n');
      await new Promise((r) => setTimeout(r, 800));
      await this.decide(run.id, 'approve', 'Автопилот').catch((e) => this.warn(this.mustLoad(run.id), `Автопилот не смог принять план — примите его сами: ${(e as Error).message}`));
      return;
    }
    if (gate === 'limit' && !run.autoRetried) {
      const r = this.mustLoad(run.id);
      r.autoRetried = true;
      this.save(r);
      this.log(run, c.violet('Автопилот: попытки исчерпаны — даю ещё одну сам; следующий раз решите вы.') + '\n');
      await new Promise((res) => setTimeout(res, 800));
      await this.decide(run.id, 'approve').catch((e) => this.warn(this.mustLoad(run.id), `Автопилот не смог дать ещё одну попытку: ${(e as Error).message}`));
    }
  }

  begin(run: RunFile, stage: StageId, model?: string, quiet = false): StageAttempt {
    const n = run.attempts.filter((a) => a.stage === stage).length + 1;
    const a: StageAttempt = { stage, attempt: n, startedAt: new Date().toISOString(), status: 'running', model: model || undefined };
    run.attempts.push(a);
    this.save(run);
    if (!isGate(stage) && !quiet) this.log(run, '\n' + c.violet(c.bold(`━━ ${STAGE_TITLES[stage]} · попытка ${n}`)) + '\n');
    this.emit({ type: 'stage.started', runId: run.id, stage, attempt: n });
    return a;
  }

  end(run: RunFile, a: StageAttempt, status: StageAttempt['status'], summary?: string, error?: string) {
    a.status = status;
    a.endedAt = new Date().toISOString();
    if (summary) a.summary = summary;
    if (error) a.error = error;
    this.save(run);
  }

  /** Общая обработка результата агента: токены, остановка, ошибка. */
  afterAgent(run: RunFile, a: StageAttempt, res: AgentResult) {
    a.tokens = addUsage(a.tokens ?? emptyUsage(), res.usage);
    run.totals = addUsage(run.totals, res.usage);
    this.save(run);
    if (res.stopped || this.stopping.has(run.id)) throw new StopSignal();
    if (!res.ok) throw new Error(res.error ?? 'Агент завершился с ошибкой');
  }

  checkStop(run: RunFile) {
    if (this.stopping.has(run.id)) throw new StopSignal();
  }

  markStopped(run: RunFile, message: string) {
    for (const a of run.attempts) if (a.status === 'running' && !isGate(a.stage)) Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
    run.status = 'stopped';
    run.message = message;
    this.save(run);
    this.log(run, c.amber(`■ ${message}`) + '\n');
    this.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message });
  }

  fail(run: RunFile, error: string) {
    const stage = run.next;
    for (const a of run.attempts) if (a.status === 'running') Object.assign(a, { status: 'failed', endedAt: new Date().toISOString(), error });
    run.status = 'stopped';
    run.message = error;
    this.save(run);
    this.log(run, c.coral(`✗ ${error}`) + '\n');
    this.emit({ type: 'stage.failed', runId: run.id, stage, error });
    this.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message: error });
  }

  /** Правила режима — дополнение к системному промпту роли (prompts/<role>.<mode>.md). */
  modeRules(role: 'planner' | 'executor' | 'review' | 'visual', run: RunFile): string {
    const file = `${role}.${modeOf(run)}.md`;
    try {
      return '\n\n' + this.prompts.raw(file);
    } catch {
      return '';
    }
  }

  /** Шаблон промпта режима, если есть (implement.quick.md), иначе общий. */
  tpl(base: string, run: RunFile): string {
    const name = `${base}.${modeOf(run)}.md`;
    try {
      this.prompts.raw(name);
      return name;
    } catch {
      return `${base}.md`;
    }
  }

  phaseBlock(run: RunFile): string {
    if (modeOf(run) !== 'epic' || !run.phases) return '';
    return `\n## Этап ${run.phase ?? 1} из ${run.phases}\n\nВыполни только пункты раздела «## ${run.phase ?? 1}.» в tasks.md. Следующие этапы не трогай — они будут отдельными шагами после проверок.\n`;
  }

  feedbackBlock(f?: Feedback): string {
    if (!f) return '';
    const source = { validator: 'валидатор OpenSpec', tests: 'тесты', review: 'ревьюер', human: 'человек', system: 'оркестратор' }[f.source];
    const lines = f.lineComments?.length
      ? '\nЗамечания на строках:\n' + f.lineComments.map((l) => `- ${l.file}:${l.line}${l.quote ? ` («${l.quote}»)` : ''} — ${l.text}`).join('\n')
      : '';
    return this.prompts.render('feedback.md', { source, text: f.text, lineComments: lines });
  }

  /**
   * Служебный вызов claude — сводка, уроки, карта плана, команды, режим, профиль, проверка окружения:
   * прокси, вход и модель из настроек в одном месте. По умолчанию без инструментов и во временной папке.
   */
  async service(o: {
    prompt: string; group: string; timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv; tools?: string[];
    model?: string; addDirs?: string[]; idleTimeoutMs?: number; userConfig?: boolean; onOutput?: (t: string) => void;
    /** Агент, выбранный в настройках (менеджер, проверка окружения); если его нет на машине — как у служебных вызовов. */
    agent?: AgentKind;
    /** Нужен браузер и запись вне рабочей копии (проверка окружения) — у codex песочница без ограничений. */
    fullAccess?: boolean;
  }): Promise<AgentResult> {
    const s = this.opts.getSettings();
    const agent = o.agent && (await this.hasTool(o.agent)) ? o.agent : await this.serviceAgent();
    const tools = await this.tools([agent]);
    const common = {
      bin: tools[agent], cwd: o.cwd ?? os.tmpdir(), env: o.env ?? this.opts.env, prompt: o.prompt,
      timeoutMs: o.timeoutMs, idleTimeoutMs: o.idleTimeoutMs, group: o.group, onOutput: o.onOutput ?? (() => {}),
      proxy: s.proxy.baseUrl ? s.proxy : undefined, userConfig: o.userConfig,
    };
    if (agent === 'codex') {
      // Без claude служебное — на codex в песочнице только для чтения: соседние каталоги он читает и так, список инструментов не нужен.
      return this.codex({ ...common, model: o.model || this.agentModel('codex', s.agents, s.models) || undefined, sandbox: o.fullAccess ? 'danger-full-access' : 'read-only' });
    }
    return this.claude({
      ...common, claudeAuth: s.claudeAuth,
      model: o.model || this.claudeModel(s.agents, s.models) || undefined,
      addDirs: o.addDirs, tools: o.tools ?? [],
    });
  }

  /** Кто выполняет служебные вызовы (сводка, профиль, уроки, менеджер): claude, а если его нет — codex. */
  async serviceAgent(): Promise<AgentKind> {
    if (await this.hasTool('claude')) return 'claude';
    if (await this.hasTool('codex')) return 'codex';
    throw new Error('Не найдены ни claude, ни codex. Укажите пути в настройках.');
  }

  async hasTool(name: keyof Tools): Promise<boolean> {
    const t = (await detectTools(this.opts.env, this.opts.getSettings().toolPaths))[name];
    return Boolean(t.path && !t.error);
  }

  /** Модель первой роли, которую выполняет этот агент. */
  agentModel(agent: AgentKind, agents: Partial<Record<Role, AgentKind>> | undefined, models: Record<Role, string>): string {
    const a = { ...DEFAULT_AGENTS, ...agents };
    const role = (['executor', 'planner', 'reviewer'] as Role[]).find((r) => a[r] === agent);
    return role ? models[role] : '';
  }

  /** Модель для служебных запусков claude: модель исполнителя или планировщика, если эту роль выполняет claude. */
  claudeModel(agents: Partial<Record<Role, AgentKind>> | undefined, models: Record<Role, string>): string {
    const a = { ...DEFAULT_AGENTS, ...agents };
    if (a.executor === 'claude') return models.executor;
    if (a.planner === 'claude') return models.planner;
    return '';
  }

  /**
   * Запуск агента роли: claude или codex — как выбрано в настройках на момент старта прогона.
   * readOnly — стадия не меняет файлы (уточнение, ревью): у claude это требование промпта, инструменты не ограничены; у codex — песочница read-only.
   */
  async runRole(run: RunFile, role: Role, o: {
    prompt: string; systemPrompt?: string; openspec?: boolean; readOnly?: boolean; images?: string[]; outputSchema?: object;
    sessionId?: string; resume?: string;
    /** Свой приёмник вывода (параллельное ревью копит вывод, чтобы не перемешать лог с проверками). */
    onOutput?: (text: string) => void;
  }): Promise<AgentResult> {
    const agent = run.agents?.[role] ?? DEFAULT_AGENTS[role];
    const tools = await this.tools(o.openspec ? [agent, 'openspec'] : [agent]);
    const base = { ...this.agentBase(run, tools[agent], o.openspec ? tools.openspec : undefined), ...(o.onOutput ? { onOutput: o.onOutput } : {}) };
    const model = run.models[role] || undefined;
    // Знания о проекте (профиль и уроки) — всем ролям; в продолжении сессии они уже в контексте.
    const systemPrompt = o.resume ? o.systemPrompt : `${o.systemPrompt ?? ''}${this.knowledgeBlock(run)}` || undefined;
    if (agent === 'codex') {
      return this.codex({ ...base, prompt: o.prompt, systemPrompt, model, sandbox: o.readOnly ? 'read-only' : 'workspace-write', images: o.images, outputSchema: o.outputSchema });
    }
    // claude не принимает изображения флагом — даём пути, он откроет их инструментом Read.
    const images = o.images?.filter((f) => fs.existsSync(f)) ?? [];
    const prompt = images.length ? `${o.prompt}\n\nИзображения (открой инструментом Read):\n${images.map((f) => `- ${f}`).join('\n')}` : o.prompt;
    const dirs = [...new Set([...(base.addDirs ?? []), ...images.map((f) => path.dirname(f))])];
    return this.claude({
      ...base,
      prompt,
      systemPrompt,
      model,
      addDirs: dirs.length ? dirs : undefined,
      sessionId: o.sessionId,
      resume: o.resume,
    });
  }

  agentBase(run: RunFile, bin: string, openspecBin?: string) {
    const s = this.opts.getSettings();
    // Агенту нужен тот же openspec, что и ядру.
    const env = openspecBin ? prependPath(this.opts.env, path.dirname(openspecBin)) : this.opts.env;
    return {
      bin,
      cwd: run.worktreePath,
      env,
      // Агента не обрываем за долгую работу: останавливаем, только если он молчит agentTimeoutMin (завис),
      // или по жёсткому потолку ×4. О долгой работе человеку подсказывает окно прогона.
      timeoutMs: Math.max(1, s.agentTimeoutMin) * 4 * 60_000,
      idleTimeoutMs: Math.max(1, s.agentTimeoutMin) * 60_000,
      group: run.id,
      onOutput: (text: string) => this.log(run, text, false),
      proxy: s.proxy.baseUrl ? s.proxy : undefined,
      claudeAuth: s.claudeAuth,
      userConfig: s.userConfig ?? true,
      addDirs: this.agentDirs(run),
    };
  }

  /** Каталоги, которые агент видит помимо рабочей копии: вложения задачи и соседние репозитории (только чтение). */
  agentDirs(run: RunFile): string[] | undefined {
    const dirs = [...(run.attachments?.length ? [path.dirname(run.attachments[0])] : []), ...relatedRepos(this, run.projectPath).map((r) => r.path)];
    return dirs.length ? dirs : undefined;
  }

  attachmentsDir(id: string): string {
    return path.join(this.opts.dataDir, 'attachments', id);
  }

  /** Файлы задачи (изображения, документы, логи) — в каталог данных приложения, чтобы не попасть в коммит репозитория. */
  saveAttachments(id: string, files: { name: string; data: Uint8Array }[]): string[] {
    if (!files.length) return [];
    const dir = this.attachmentsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    return files.map((f, i) => {
      const ext = path.extname(f.name).toLowerCase().replace(/[^.a-z0-9]/g, '');
      const base = path.basename(f.name, path.extname(f.name)).replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 60) || 'file';
      const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${base}${ext}`);
      fs.writeFileSync(file, Buffer.from(f.data));
      return file;
    });
  }

  attachmentsBlock(run: RunFile): string {
    if (!run.attachments?.length) return '';
    const images = run.attachments.filter(isImageFile);
    return [
      images.length ? `\nК задаче приложены изображения (макеты, скриншоты). Открой их инструментом Read и учитывай:\n${images.map((p) => `- ${p}`).join('\n')}\n` : '',
      this.filesBlock(run),
    ].join('');
  }

  /** Не изображения: небольшие текстовые — прямо в промпт, остальные — путями (агент прочитает сам). */
  filesBlock(run: RunFile): string {
    const files = (run.attachments ?? []).filter((p) => !isImageFile(p) && fs.existsSync(p));
    if (!files.length) return '';
    const fence = '`'.repeat(4);
    const parts = files.map((p) => {
      const name = path.basename(p).replace(/^\d+-/, '');
      const text = readSmallText(p);
      return text !== null
        ? `### ${name}\n\n${fence}\n${text}\n${fence}`
        : `- ${p} (${name}, ${Math.max(1, Math.round(fs.statSync(p).size / 1024))} КБ) — открой и прочитай, если нужно для задачи`;
    });
    return `\nК задаче приложены файлы от человека — учитывай их:\n\n${parts.join('\n\n')}\n`;
  }

  /** Вложение для показа в окне: data URL изображения; null — не изображение или файла нет. */
  getAttachment(id: string, index: number): string | null {
    const r = this.mustLoad(id);
    const file = r.attachments?.[index];
    if (!file || !fs.existsSync(file) || !isImageFile(file)) return null;
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  }

  shell(run: RunFile, command: string, timeoutMin: number) {
    return runProc(command, [], {
      cwd: run.worktreePath,
      env: { ...this.opts.env, CI: '1', FORCE_COLOR: '1' },
      shell: true,
      timeoutMs: Math.max(1, timeoutMin) * 60_000,
      group: run.id,
      onStdout: (t) => this.log(run, crlf(t), false),
      onStderr: (t) => this.log(run, crlf(t), false),
    });
  }

  log(run: RunFile, text: string, convert = true) {
    const t = convert ? crlf(text) : text;
    this.store.appendLog(run.id, t);
    this.emit({ type: 'agent.output', runId: run.id, stage: run.next, text: t });
  }

  /** Запуск агентов — через них, чтобы тесты конвейера могли подменить claude и codex. */
  claude(o: Parameters<typeof runClaude>[0]) { return (this.opts.runners?.claude ?? runClaude)(o); }
  codex(o: Parameters<typeof runCodex>[0]) { return (this.opts.runners?.codex ?? runCodex)(o); }

  /** Предупреждение: прогон идёт дальше, но человеку стоит знать — в логе и в окне прогона. */
  warn(run: RunFile, text: string) {
    this.log(run, c.amber(`! ${text}`) + '\n');
    run.warnings = [...(run.warnings ?? []), { at: new Date().toISOString(), text }].slice(-10);
    this.save(run);
  }

  save(run: RunFile) {
    this.store.save(run);
    this.emit({ type: 'run.updated', run: structuredClone(run) });
  }

  mustLoad(id: string): RunFile {
    const r = this.store.load(id);
    if (!r) throw new Error('Прогон не найден');
    return r;
  }

  async tools(need: (keyof Tools)[]): Promise<Tools> {
    const manual = this.opts.getSettings().toolPaths;
    const found = await detectTools(this.opts.env, manual);
    const missing = need.filter((n) => !found[n].path || found[n].error);
    if (missing.length) {
      throw new Error(`Не найдены: ${missing.join(', ')}. Укажите пути в настройках.`);
    }
    return { git: found.git.path!, claude: found.claude.path!, codex: found.codex.path!, openspec: found.openspec.path! };
  }
}
