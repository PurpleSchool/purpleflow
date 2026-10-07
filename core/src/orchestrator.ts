import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from './agents/claude.js';
import { runCodex } from './agents/codex.js';
import { addUsage, c, crlf, emptyUsage, type AgentResult } from './agents/common.js';
import { detectTools, prependPath } from './env.js';
import { Git } from './git.js';
import { makeChangeId, makeTitle } from './ids.js';
import { OpenSpec } from './openspec.js';
import { killGroup, killPid, run as runProc, setPidTracker } from './proc.js';
import { Prompts } from './prompts.js';
import { RunStore } from './store.js';
import { MODE_FIRST, MODE_LIMIT, QUICK_REVIEW_LINES, TEST_FILE, modeOf } from './modes.js';
import type {
  AiCommands, CheckResult, ModeSuggestion, ProjectConfig, RunMode, VisualResult, ConnectionCheck, CoreCommand, CoreEvent, CoreSettings, DiffFile, Feedback, GateId, LineComment, ReviewItem,
  ReviewResult, RunFile, RunSummary, StageAttempt, StageId, StartRunInput, TestResult, ToolInfo, ToolName,
} from './types.js';

export interface CoreOptions {
  dataDir: string;
  promptsDir: string;
  /** Окружение login-шелла пользователя (см. loadLoginShellEnv). */
  env: NodeJS.ProcessEnv;
  getSettings: () => CoreSettings;
}

const IMPL_LIMIT = 3;
const PLAN_RETRIES = 2;
const MAX_TEST_OUTPUT = 12_000;
const MAX_DIFF = 160_000;
const RUN_JSON_GLOB = 'openspec/changes/**/run.json';

export const STAGE_TITLES: Record<StageId, string> = {
  plan: 'План',
  gate1: 'Утверждение плана',
  implement: 'Реализация',
  tests: 'Проверки',
  baseline: 'Базовые проверки',
  visual: 'Визуальная проверка',
  review: 'Ревью',
  gate2: 'Приёмка',
  limit: 'Нужно решение',
  finish: 'Завершение',
};

type Listener = (e: CoreEvent) => void;

interface Tools { git: string; claude: string; codex: string; openspec: string }

class StopSignal extends Error {}

export class Orchestrator {
  private listeners = new Set<Listener>();
  private store: RunStore;
  private prompts: Prompts;
  /** Прогоны, по которым сейчас крутится цикл стадий. */
  private driving = new Set<string>();
  private stopping = new Set<string>();

  constructor(private opts: CoreOptions) {
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

  private emit(e: CoreEvent) {
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
      case 'run.stop':
        await this.stop(cmd.runId);
        return { runId: cmd.runId };
      case 'run.merge':
        await this.merge(cmd.runId, cmd.target);
        return { runId: cmd.runId };
    }
  }

  /** После перезапуска приложения: прогоны, оборванные посреди стадии, помечаются остановленными. */
  async recover(): Promise<void> {
    for (const s of this.store.list()) {
      // Агенты и тесты, пережившие аварийный выход приложения, не должны писать в worktree параллельно с повтором стадии.
      const orphans = [...this.store.readPids(s.id), ...this.store.readPids(`${s.id}:server`)];
      if (orphans.length) {
        await Promise.all(orphans.map(killPid));
        this.store.writePids(s.id, []);
        this.store.writePids(`${s.id}:server`, []);
      }
      if (s.status !== 'running' || s.missing) continue;
      const r = this.store.load(s.id);
      if (!r) continue;
      for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
      // Оборванная реализация — не вина исполнителя: попытку возвращаем.
      if (r.next === 'implement' && r.implAttemptsUsed > 0) r.implAttemptsUsed--;
      r.status = 'stopped';
      r.message = 'Прервано: приложение было закрыто. Нажмите «Продолжить», чтобы повторить текущую стадию.';
      this.store.save(r);
    }
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
    const skip = (p: string) => p.startsWith('openspec/') && p.endsWith('/run.json');
    // Завершённый прогон — дифф ветки прогона: рабочая копия могла уйти на другую ветку.
    if (r.status === 'finished') return git.diffCommits(r.projectPath, r.baseCommit, r.branch, skip);
    return git.diff(r.worktreePath, r.baseCommit, skip);
  }

  /** Ветки репозитория пользователя для слияния результата. */
  async listBranches(id: string): Promise<{ branches: string[]; current: string | null }> {
    const r = this.mustLoad(id);
    const tools = await this.tools(['git']);
    const b = await new Git(tools.git, this.opts.env).branches(r.projectPath);
    return { branches: b.branches.filter((x) => x !== r.branch && !x.startsWith('psflow/')), current: b.current };
  }

  /** Влить ветку прогона в выбранную ветку репозитория пользователя (решение человека). */
  private async merge(id: string, target: string) {
    const r = this.mustLoad(id);
    if (r.status !== 'finished') throw new Error('Влить можно только завершённый прогон');
    if (!target.trim()) throw new Error('Выберите ветку');
    const tools = await this.tools(['git']);
    const git = new Git(tools.git, this.opts.env);
    const sha = await git.merge(r.projectPath, r.branch, target, `Merge ${r.branch}: ${r.title}`, this.store.worktreesDir());
    r.merged = { into: target, commit: sha, at: new Date().toISOString() };
    this.save(r);
    this.log(r, c.mint(`✓ ${r.branch} влита в ${target} (${sha.slice(0, 8)})`) + '\n');
  }

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
    const tools = await this.tools(['claude', 'codex']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psflow-check-'));
    const proxy = s.proxy.baseUrl ? s.proxy : undefined;
    const prompt = 'Это проверка подключения. Ответь ровно одним словом: готово';
    const one = async (agent: 'claude' | 'codex'): Promise<ConnectionCheck> => {
      const t0 = Date.now();
      const model = agent === 'claude' ? s.models.planner : s.models.reviewer;
      const base = { bin: tools[agent], cwd: dir, env: this.opts.env, prompt, model, timeoutMs: 120_000, group: `check-${agent}`, onOutput: () => {}, proxy, claudeAuth: s.claudeAuth };
      const r = agent === 'claude' ? await runClaude(base) : await runCodex({ ...base, sandbox: 'read-only' });
      return { agent, ok: r.ok, model: model || 'по умолчанию', durationMs: Date.now() - t0, reply: r.text.trim().slice(0, 200), error: r.error };
    };
    try {
      return await Promise.all([one('claude'), one('codex')]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ——— Жизненный цикл ———

  private async start(input: StartRunInput): Promise<string> {
    const s = this.opts.getSettings();
    const tools = await this.tools(['git', 'claude', 'codex', 'openspec']);
    const git = new Git(tools.git, this.opts.env);
    if (!input.task.trim()) throw new Error('Опишите задачу');
    if (!(await git.isRepo(input.projectPath))) throw new Error('Выбранная папка не является git-репозиторием');
    const repo = await git.topLevel(input.projectPath);
    const base = await git.head(repo).catch(() => {
      throw new Error('В репозитории нет ни одного коммита — сделайте первый коммит');
    });

    const changeId = makeChangeId(input.task);
    const branch = `psflow/${changeId}`;
    const workspace = input.workspace ?? 'worktree';
    let worktreePath: string;
    let originalBranch: string | undefined;
    if (workspace === 'branch') {
      // Режим «ветка»: работаем прямо в проекте. Чужие незакоммиченные правки попали бы в коммит прогона — поэтому только с чистой копией.
      const dirty = await git.dirtyFiles(repo);
      if (dirty.length) {
        throw new Error(`В рабочей копии есть незакоммиченные изменения (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? '…' : ''}). Закоммитьте или спрячьте их (git stash) — или выберите отдельную копию (worktree).`);
      }
      originalBranch = (await git.currentBranch(repo)) ?? undefined;
      await git.checkoutNewBranch(repo, branch, base);
      worktreePath = repo;
    } else {
      worktreePath = path.join(this.store.worktreesDir(), `${path.basename(repo)}-${changeId}`);
      await git.addWorktree(repo, worktreePath, branch, base);
    }

    const mode = input.mode ?? 'task';
    if (mode !== 'quick') {
      const openspec = new OpenSpec(tools.openspec, this.opts.env);
      await openspec.ensureInit(worktreePath, 'init');
    }
    const visual = Boolean(input.visual && input.runCommand?.trim() && input.appUrl?.trim());

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const attachments = this.saveAttachments(id, input.attachments ?? []);
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
      testCommand: input.testCommand.trim(),
      setupCommand: input.setupCommand?.trim() || undefined,
      lintCommand: input.lintCommand?.trim() || undefined,
      mode,
      workspace,
      originalBranch,
      visual: visual || undefined,
      runCommand: visual ? input.runCommand!.trim() : undefined,
      appUrl: visual ? input.appUrl!.trim() : undefined,
      // В режиме «ветка» зависимости — уже установленные пользователем; подготовку не запускаем.
      prepared: workspace === 'branch' || !input.setupCommand?.trim(),
      models: { ...s.models },
      status: 'running',
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
    this.save(run);
    this.log(run, c.dim(`PurpleFlow · ${run.changeId}\nветка ${branch} от ${base.slice(0, 8)}\n${workspace === 'branch' ? `рабочая копия проекта ${repo} (была ветка ${originalBranch ?? 'detached HEAD'})` : `worktree ${worktreePath}`}\n`));
    void this.drive(run);
    return run.id;
  }

  private async resume(id: string) {
    if (this.driving.has(id)) return;
    const r = this.mustLoad(id);
    if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
    await this.ensureOnBranch(r);
    r.message = undefined;
    if (r.next === 'plan') r.planRetries = 0;
    if (isGate(r.next)) return this.waitGate(r, r.next as GateId, this.gateMessage(r));
    r.status = 'running';
    this.save(r);
    void this.drive(r);
  }

  /** Режим «ветка»: продолжать можно, только если проект всё ещё на ветке прогона. */
  private async ensureOnBranch(r: RunFile) {
    if (r.workspace !== 'branch') return;
    const tools = await this.tools(['git']);
    const cur = await new Git(tools.git, this.opts.env).currentBranch(r.projectPath);
    if (cur !== r.branch) throw new Error(`Проект сейчас на ветке ${cur ?? 'detached HEAD'}. Переключитесь на ${r.branch} (git checkout ${r.branch}) и продолжите.`);
  }

  private async stop(id: string) {
    const r = this.store.load(id);
    if (!r) return;
    await killGroup(`${id}:server`);
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

  private async decide(id: string, decision: 'approve' | 'reject' | 'cancel', comment?: string, lineComments?: LineComment[]) {
    const r = this.mustLoad(id);
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

    if (gate === 'gate1') {
      if (decision === 'approve') {
        r.next = 'implement';
        r.feedback = undefined;
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

  private async drive(run: RunFile) {
    if (this.driving.has(run.id)) return;
    this.driving.add(run.id);
    this.stopping.delete(run.id);
    try {
      while (run.status === 'running') {
        if (isGate(run.next)) {
          this.waitGate(run, run.next as GateId, this.gateMessage(run));
          break;
        }
        switch (run.next) {
          case 'baseline': await this.stageBaseline(run); break;
          case 'visual': await this.stageVisual(run); break;
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
    }
  }

  private async stagePlan(run: RunFile) {
    const s = this.opts.getSettings();
    const tools = await this.tools(['claude', 'openspec']);
    const attempt = this.begin(run, 'plan', run.models.planner);

    if (!run.prepared && run.setupCommand) {
      this.log(run, c.sky(`$ ${run.setupCommand}`) + '\n');
      const r = await this.shell(run, run.setupCommand, s.testTimeoutMin);
      this.checkStop(run);
      if (r.code !== 0) throw new Error(`Команда подготовки «${run.setupCommand}» завершилась с кодом ${r.code}${r.timedOut ? ' (таймаут)' : ''}`);
      run.prepared = true;
      this.save(run);
    }

    const prompt = this.prompts.render('plan.md', {
      changeId: run.changeId,
      task: run.task,
      attachments: this.attachmentsBlock(run),
      testCommand: run.testCommand || 'не задана',
      feedback: this.feedbackBlock(run.feedback),
    });
    const res = await runClaude({
      ...this.agentBase(run, tools.claude, tools.openspec),
      prompt,
      systemPrompt: this.prompts.raw('planner.system.md') + this.modeRules('planner', run),
      model: run.models.planner,
    });
    this.afterAgent(run, attempt, res);

    const mode = modeOf(run);
    const changeDir = path.join(run.worktreePath, 'openspec', 'changes', run.changeId);
    if (mode === 'refactor' && fs.existsSync(changeDir)) {
      // Рефакторинг не меняет поведение: изменение без дельт спецификаций.
      fs.writeFileSync(path.join(changeDir, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
    }
    const openspec = new OpenSpec(tools.openspec, this.opts.env);
    const v = await openspec.validate(run.worktreePath, run.changeId, run.id);
    this.checkStop(run);
    if (v.valid && mode === 'epic' && !fs.existsSync(path.join(changeDir, 'design.md'))) {
      v.valid = false;
      v.issues.push({ level: 'ERROR', message: 'Для большой задачи нужен design.md: варианты решения, выбранный подход и разбиение на этапы.' });
    }
    if (v.valid && mode === 'epic') {
      run.phases = Math.max(1, Math.min(8, countPhases((await this.getChangeDocs(run.id)).tasks)));
    }
    if (v.valid && mode === 'bug') {
      // Воспроизведение засчитано, только если проверки на текущем коде красные.
      this.log(run, c.dim('Проверяем, что баг воспроизведён: проверки должны упасть…') + '\n');
      const { result } = await this.runChecks(run);
      run.repro = result;
      if (!result.checks?.length) {
        v.valid = false;
        v.issues.push({ level: 'ERROR', message: 'Не заданы команды тестов — воспроизвести баг тестом нельзя. Укажите команду тестов в командах проекта.' });
      } else if (result.passed) {
        v.valid = false;
        v.issues.push({ level: 'ERROR', message: 'Тест воспроизведения не падает: все проверки зелёные на текущем коде. Напиши тест, который падает именно из-за бага.' });
      } else {
        this.log(run, c.mint('✓ баг воспроизведён: проверки красные, как и ожидалось') + '\n');
      }
    }
    if (v.valid) {
      this.log(run, c.mint('✓ openspec validate: изменение валидно') + '\n');
      const title = planTitle((await this.getChangeDocs(run.id)).proposal);
      if (title) {
        run.title = title;
        run.titleFromPlan = true;
      }
      this.end(run, attempt, 'done', firstLine(res.text) || 'План готов');
      run.feedback = undefined;
      run.planRetries = 0;
      run.next = 'gate1';
      this.save(run);
      return;
    }
    const issues = v.issues.map((i) => `- [${i.level}] ${i.path ? i.path + ': ' : ''}${i.message}`).join('\n');
    this.log(run, c.coral('✗ openspec validate:\n' + issues) + '\n');
    this.end(run, attempt, 'failed', 'План не прошёл валидацию', issues);
    if (run.planRetries < PLAN_RETRIES) {
      run.planRetries++;
      run.feedback = { source: 'validator', text: `\`openspec validate ${run.changeId} --strict\` нашёл ошибки:\n${issues}` };
      run.next = 'plan';
      this.save(run);
      return;
    }
    run.feedback = { source: 'validator', text: `\`openspec validate ${run.changeId} --strict\` нашёл ошибки:\n${issues}` };
    this.markStopped(run, `План не прошёл openspec validate после ${PLAN_RETRIES + 1} попыток. Исправьте файлы вручную или нажмите «Продолжить».`);
  }

  private async stageImplement(run: RunFile) {
    const tools = await this.tools(['claude', 'openspec']);
    run.implAttemptsUsed++;
    const attempt = this.begin(run, 'implement', run.models.executor);
    const prompt = this.prompts.render(this.tpl('implement', run), {
      changeId: run.changeId,
      task: run.task,
      attachments: this.attachmentsBlock(run),
      testCommand: run.testCommand || 'не задана',
      attempt: run.implAttemptsUsed,
      limit: run.implAttemptsLimit,
      feedback: this.phaseBlock(run) + this.feedbackBlock(run.feedback),
    });
    let res: AgentResult;
    try {
      res = await runClaude({
        ...this.agentBase(run, tools.claude, tools.openspec),
        prompt,
        systemPrompt: this.prompts.raw('executor.system.md') + this.modeRules('executor', run),
        model: run.models.executor,
      });
      this.afterAgent(run, attempt, res);
    } catch (e) {
      // Сбой агента (ключ, токены, таймаут) не тратит попытку реализации.
      run.implAttemptsUsed--;
      throw e;
    }
    if (modeOf(run) === 'quick' && !run.titleFromPlan) {
      // Плана нет — короткое название пишет исполнитель последней строкой «НАЗВАНИЕ: …».
      const m = res.text.match(/НАЗВАНИЕ:\s*(.+)\s*$/m);
      if (m) {
        run.title = m[1].replace(/[`*]/g, '').trim().slice(0, 72);
        run.titleFromPlan = true;
      }
    }
    const report = res.text.replace(/^НАЗВАНИЕ:.*$/m, '').trim();
    if (report) attempt.output = report;
    this.end(run, attempt, 'done', firstLine(report) || 'Реализация выполнена');
    run.next = 'tests';
    this.save(run);
  }

  /** Линтер и тесты в worktree. Общий для «Проверок», базовых проверок и воспроизведения бага. */
  private async runChecks(run: RunFile): Promise<{ result: TestResult; failed: CheckResult[] }> {
    const s = this.opts.getSettings();
    const plan: { kind: CheckResult['kind']; command: string }[] = [];
    if (run.lintCommand) plan.push({ kind: 'lint', command: run.lintCommand });
    if (run.testCommand) plan.push({ kind: 'test', command: run.testCommand });
    const checks: CheckResult[] = [];
    for (const p of plan) {
      this.log(run, c.sky(`$ ${p.command}`) + c.dim(`  # ${CHECK_NAME[p.kind]}`) + '\n');
      const r = await this.shell(run, p.command, s.testTimeoutMin);
      this.checkStop(run);
      const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
      const check: CheckResult = {
        kind: p.kind,
        command: p.command,
        passed: r.code === 0 && !r.timedOut && !r.spawnError,
        exitCode: r.code,
        durationMs: r.durationMs,
        output: r.spawnError ? `Не удалось запустить: ${r.spawnError}` : output.length > MAX_TEST_OUTPUT ? '…\n' + output.slice(-MAX_TEST_OUTPUT) : output,
        timedOut: r.timedOut || undefined,
      };
      checks.push(check);
      this.log(run, (check.passed ? c.mint(`✓ ${CHECK_NAME[p.kind]}: ok`) : c.coral(`✗ ${CHECK_NAME[p.kind]}: код ${check.exitCode}${check.timedOut ? ', таймаут' : ''}`)) + '\n');
    }
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
      : { at: new Date().toISOString(), command: '', passed: true, exitCode: 0, durationMs: 0, output: 'Команды линтера и тестов не заданы — проверки пропущены.', checks: [] };
    if (!checks.length) this.log(run, c.amber(result.output) + '\n');
    return { result, failed };
  }

  private checksFeedback(failed: CheckResult[]): string {
    return failed.map((x) => `${x.kind === 'lint' ? 'Линтер' : 'Тесты'} не прошли. Команда: \`${x.command}\`, код выхода ${x.exitCode}${x.timedOut ? ' (таймаут)' : ''}.\n\nВывод:\n\`\`\`\n${x.output}\n\`\`\``).join('\n\n');
  }

  private async stageTests(run: RunFile) {
    const attempt = this.begin(run, 'tests');

    // Рефакторинг: тесты — эталон поведения, менять их нельзя.
    if (modeOf(run) === 'refactor') {
      const tools = await this.tools(['git']);
      const changed = await new Git(tools.git, this.opts.env).changedFiles(run.worktreePath, run.baseCommit);
      const touched = changed.filter((f) => TEST_FILE.test(f) && !f.startsWith('openspec/'));
      if (touched.length) {
        this.log(run, c.coral(`✗ рефакторинг изменил тесты: ${touched.join(', ')}`) + '\n');
        this.end(run, attempt, 'failed', 'Изменены тесты');
        run.feedback = { source: 'tests', text: `Это рефакторинг: поведение и тесты менять нельзя. Верни эти файлы тестов к исходному виду (git checkout ${run.baseCommit.slice(0, 8)} -- <файл>) и добейся зелёных проверок без их правки:\n${touched.map((f) => `- ${f}`).join('\n')}` };
        this.nextImplementOrLimit(run, 'Рефакторинг снова и снова меняет тесты.');
        return;
      }
    }

    const { result, failed } = await this.runChecks(run);
    run.tests.push(result);
    this.emit({ type: 'tests.result', runId: run.id, result });
    const checks = result.checks ?? [];
    const summary = !checks.length ? 'Пропущены'
      : failed.length ? `Красные: ${failed.map((x) => CHECK_NAME[x.kind]).join(' и ')}`
      : checks.map((x) => CHECK_NAME[x.kind]).join(' и ').replace(/^./, (m) => m.toUpperCase()) + ' — ok';
    this.end(run, attempt, result.passed ? 'done' : 'failed', summary);

    if (result.passed) {
      run.feedback = undefined;
      // Большая задача: следующий этап реализации со свежим запасом попыток.
      if (modeOf(run) === 'epic' && run.phases && (run.phase ?? 1) < run.phases) {
        run.phase = (run.phase ?? 1) + 1;
        run.implAttemptsUsed = 0;
        run.implAttemptsLimit = MODE_LIMIT.epic;
        this.log(run, c.violet(`→ этап ${run.phase} из ${run.phases}`) + '\n');
        run.next = 'implement';
        this.save(run);
        return;
      }
      run.next = run.visual ? 'visual' : await this.reviewOrAccept(run);
      this.save(run);
      return;
    }
    run.feedback = { source: 'tests', text: this.checksFeedback(failed) };
    this.nextImplementOrLimit(run, `Проверки красные после ${run.implAttemptsUsed} попыток реализации.`);
  }

  /** Рефакторинг начинается с зелёных проверок: иначе нечем доказать, что поведение не изменилось. */
  private async stageBaseline(run: RunFile) {
    const s = this.opts.getSettings();
    const attempt = this.begin(run, 'baseline');
    if (!run.prepared && run.setupCommand) {
      this.log(run, c.sky(`$ ${run.setupCommand}`) + '\n');
      const r = await this.shell(run, run.setupCommand, s.testTimeoutMin);
      this.checkStop(run);
      if (r.code !== 0) throw new Error(`Команда подготовки «${run.setupCommand}» завершилась с кодом ${r.code}${r.timedOut ? ' (таймаут)' : ''}`);
      run.prepared = true;
    }
    const { result } = await this.runChecks(run);
    run.repro = result;
    if (!result.checks?.length) {
      this.end(run, attempt, 'failed', 'Нет проверок');
      this.markStopped(run, 'Для рефакторинга нужны команды линтера или тестов — без них нельзя доказать, что поведение не изменилось. Задайте их в командах проекта.');
      return;
    }
    if (!result.passed) {
      this.end(run, attempt, 'failed', 'Красные до начала');
      this.markStopped(run, 'Проверки красные ещё до рефакторинга. Почините их отдельной задачей (режим «Баг»), затем повторите рефакторинг.');
      return;
    }
    this.end(run, attempt, 'done', 'Зелёные — эталон зафиксирован');
    run.next = 'plan';
    this.save(run);
  }

  /** Быстрая правка с маленьким диффом идёт на приёмку без ревью. */
  private async reviewOrAccept(run: RunFile): Promise<StageId> {
    if (modeOf(run) !== 'quick') return 'review';
    const tools = await this.tools(['git']);
    const diff = await new Git(tools.git, this.opts.env).diffText(run.worktreePath, run.baseCommit, [RUN_JSON_GLOB]);
    const lines = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
    if (lines <= QUICK_REVIEW_LINES) {
      this.log(run, c.dim(`Дифф ${lines} строк — ревью пропущено (быстрая правка).`) + '\n');
      return 'gate2';
    }
    return 'review';
  }

  /** Сохранённые команды проекта (null — ещё не настраивали). */
  getProjectConfig(repo: string): ProjectConfig | null {
    return this.store.readProjects()[path.resolve(repo)] ?? null;
  }

  saveProjectConfig(repo: string, cfg: Omit<ProjectConfig, 'updatedAt'>): ProjectConfig {
    const full: ProjectConfig = {
      setupCommand: cfg.setupCommand.trim(),
      lintCommand: cfg.lintCommand.trim(),
      testCommand: cfg.testCommand.trim(),
      runCommand: cfg.runCommand?.trim() || undefined,
      appUrl: cfg.appUrl?.trim() || undefined,
      workspace: cfg.workspace,
      notes: cfg.notes,
      updatedAt: new Date().toISOString(),
    };
    this.store.writeProject(path.resolve(repo), full);
    return full;
  }

  /**
   * Нейросеть осматривает проект (только чтение: Read/Glob/Grep) и предлагает команды
   * подготовки, линтера и тестов. Работает в папке проекта, ничего не меняя.
   */
  async detectCommandsAI(dir: string): Promise<AiCommands> {
    const s = this.opts.getSettings();
    const tools = await this.tools(['claude']);
    const res = await runClaude({
      bin: tools.claude,
      cwd: dir,
      env: this.opts.env,
      prompt: this.prompts.raw('detect-commands.md'),
      model: s.models.executor || undefined,
      timeoutMs: 3 * 60_000,
      group: `detect-${Date.now()}`,
      onOutput: () => {},
      proxy: s.proxy.baseUrl ? s.proxy : undefined,
      claudeAuth: s.claudeAuth,
      tools: ['Read', 'Glob', 'Grep'],
    });
    if (!res.ok) throw new Error(res.error ?? 'Не удалось определить команды');
    const a = res.text.indexOf('{');
    const b = res.text.lastIndexOf('}');
    try {
      const j = JSON.parse(res.text.slice(a, b + 1));
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      return {
        setupCommand: str(j.setup),
        lintCommand: str(j.lint),
        testCommand: str(j.test),
        runCommand: str(j.run),
        appUrl: str(j.url),
        notes: { setup: str(j.notes?.setup), lint: str(j.notes?.lint), test: str(j.notes?.test), run: str(j.notes?.run) },
      };
    } catch {
      throw new Error(`Нейросеть ответила не в формате JSON: ${res.text.slice(0, 300)}`);
    }
  }

  /** Режим по тексту задачи — подсказка человеку, решение за ним. */
  async suggestMode(task: string): Promise<ModeSuggestion> {
    const s = this.opts.getSettings();
    const tools = await this.tools(['claude']);
    const res = await runClaude({
      bin: tools.claude,
      cwd: os.tmpdir(),
      env: this.opts.env,
      prompt: this.prompts.render('suggest-mode.md', { task }),
      model: s.models.executor || undefined,
      timeoutMs: 90_000,
      group: `mode-${Date.now()}`,
      onOutput: () => {},
      proxy: s.proxy.baseUrl ? s.proxy : undefined,
      claudeAuth: s.claudeAuth,
      tools: [],
    });
    if (!res.ok) throw new Error(res.error ?? 'Не удалось определить режим');
    try {
      const j = JSON.parse(res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1));
      const modes: RunMode[] = ['quick', 'bug', 'task', 'epic', 'refactor'];
      return { mode: modes.includes(j.mode) ? j.mode : 'task', reason: String(j.reason ?? '').trim() };
    } catch {
      throw new Error(`Нейросеть ответила не в формате JSON: ${res.text.slice(0, 200)}`);
    }
  }

  private visualDir(run: RunFile, attempt: number): string {
    return path.join(this.opts.dataDir, 'visual', run.id, String(attempt));
  }

  /**
   * Визуальная проверка: поднять приложение в worktree на свободном порту, дать агенту
   * браузер (Playwright CLI через обёртку pw — служебные файлы остаются вне репозитория),
   * собрать скриншоты и вердикт { blocking, notes, shots }.
   */
  private async stageVisual(run: RunFile) {
    const s = this.opts.getSettings();
    const tools = await this.tools(['claude']);
    const attempt = this.begin(run, 'visual', run.models.executor);
    const dir = this.visualDir(run, attempt.attempt);
    fs.mkdirSync(dir, { recursive: true });
    const port = await freePort();
    const url = run.appUrl!.replaceAll('{port}', String(port));
    const command = run.runCommand!.replaceAll('{port}', String(port));
    const serverGroup = `${run.id}:server`;

    this.log(run, c.sky(`$ ${command}`) + c.dim(`  # приложение на ${url}`) + '\n');
    let exited: number | null | undefined;
    const server = runProc(command, [], {
      cwd: run.worktreePath,
      env: { ...this.opts.env, PORT: String(port), BROWSER: 'none', CI: '1' },
      shell: true,
      group: serverGroup,
      onStdout: (t) => this.log(run, c.dim(crlf(t)), false),
      onStderr: (t) => this.log(run, c.dim(crlf(t)), false),
    });
    void server.then((r) => { exited = r.code; });

    try {
      const ready = await waitForUrl(url, 120_000, () => exited !== undefined || this.stopping.has(run.id));
      this.checkStop(run);
      if (!ready) {
        throw new Error(exited !== undefined
          ? `Приложение завершилось с кодом ${exited}, не открыв ${url}. Проверьте команду запуска в командах проекта.`
          : `За 2 минуты приложение не ответило на ${url}. Проверьте команду запуска и адрес ({port} подставляется автоматически).`);
      }
      this.log(run, c.mint(`✓ приложение отвечает на ${url}`) + '\n');

      // pw: обёртка над Playwright CLI с отдельной сессией и рабочей папкой для скриншотов.
      const session = `psflow-${run.id.slice(0, 8)}`;
      const isWin = process.platform === 'win32';
      if (isWin) {
        fs.writeFileSync(path.join(dir, 'pw.cmd'), `@echo off\r\ncd /d "${dir}"\r\nnpx -y @playwright/cli@latest -s=${session} %*\r\n`);
      } else {
        fs.writeFileSync(path.join(dir, 'pw'), `#!/bin/sh\ncd "${dir}" && exec npx -y @playwright/cli@latest -s=${session} "$@"\n`, { mode: 0o755 });
      }
      const docs = await this.getChangeDocs(run.id);
      const tg = await this.tools(['git']);
      const changed = await new Git(tg.git, this.opts.env).changedFiles(run.worktreePath, run.baseCommit);
      const prompt = this.prompts.render('visual.md', {
        url,
        dir,
        task: run.task,
        attachments: this.attachmentsBlock(run),
        proposal: docs.proposal || '(нет плана — быстрая правка, ориентируйся на задачу)',
        specs: docs.specs.map((x) => x.content).join('\n\n') || '(нет)',
        files: changed.filter((f) => !f.startsWith('openspec/')).map((f) => `- ${f}`).join('\n') || '(нет)',
      });
      const res = await runClaude({
        ...this.agentBase(run, tools.claude),
        env: prependPath(this.opts.env, dir),
        prompt,
        systemPrompt: this.prompts.raw('visual.system.md') + this.modeRules('visual', run),
        model: run.models.executor,
        addDirs: [dir, ...(run.attachments?.length ? [path.dirname(run.attachments[0])] : [])],
        // Только смотреть: браузер через Bash (pw), чтение кода — без правки файлов.
        tools: ['Bash', 'Read', 'Glob', 'Grep'],
      });
      this.afterAgent(run, attempt, res);

      const parsed = parseReview(res.text);
      if (!parsed) throw new Error(`Визуальная проверка вернула ответ не в формате JSON:\n${res.text.slice(0, 400)}`);
      const shotsRaw = parseShots(res.text);
      const shots = shotsRaw
        .map((x) => ({ file: path.isAbsolute(x.file) ? x.file : path.join(dir, x.file), caption: x.caption }))
        .filter((x) => x.file.startsWith(dir) && fs.existsSync(x.file));
      // Скриншоты, которые агент снял, но не перечислил, тоже показываем.
      for (const f of fs.readdirSync(dir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort()) {
        const full = path.join(dir, f);
        if (!shots.some((x) => x.file === full)) shots.push({ file: full, caption: f });
      }
      const result: VisualResult = { at: new Date().toISOString(), url, blocking: parsed.blocking, notes: parsed.notes, shots };
      run.visuals = [...(run.visuals ?? []), result];
      const fmt = (i: ReviewItem) => `${i.file ? `${i.file}${i.line ? ':' + i.line : ''} — ` : ''}${i.message}`;
      if (result.blocking.length) this.log(run, c.coral(`✗ визуальные проблемы (${result.blocking.length}):\n`) + result.blocking.map((i) => `  • ${fmt(i)}`).join('\n') + '\n');
      this.log(run, c.dim(`скриншотов: ${shots.length}`) + '\n');
      this.end(run, attempt, result.blocking.length ? 'failed' : 'done',
        result.blocking.length ? `Проблем: ${result.blocking.length}, скриншотов: ${shots.length}` : `Выглядит верно, скриншотов: ${shots.length}`);

      if (!result.blocking.length) {
        run.next = await this.reviewOrAccept(run);
        this.save(run);
        return;
      }
      run.feedback = {
        source: 'review',
        text: 'Визуальная проверка в браузере нашла проблемы. Исправь каждую; скриншоты можно открыть инструментом Read:\n'
          + result.blocking.map((i) => `- ${fmt(i)}`).join('\n')
          + (shots.length ? '\n\nСкриншоты:\n' + shots.map((x) => `- ${x.file} — ${x.caption}`).join('\n') : ''),
      };
      this.nextImplementOrLimit(run, 'Визуальная проверка снова нашла проблемы, а попытки реализации исчерпаны.');
    } finally {
      await runProc('npx', ['-y', '@playwright/cli@latest', `-s=psflow-${run.id.slice(0, 8)}`, 'close'], { cwd: dir, env: this.opts.env, timeoutMs: 20_000 }).catch(() => undefined);
      await killGroup(serverGroup);
    }
  }

  /** Скриншот визуальной проверки для окна: data URL (только из каталога прогона). */
  getVisualShot(id: string, file: string): string | null {
    const root = path.join(this.opts.dataDir, 'visual', id);
    const full = path.resolve(file);
    if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) return null;
    const ext = path.extname(full).slice(1).toLowerCase();
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext || 'png'};base64,${fs.readFileSync(full).toString('base64')}`;
  }

  private async stageReview(run: RunFile) {
    const tools = await this.tools(['git', 'codex']);
    const attempt = this.begin(run, 'review', run.models.reviewer);
    const git = new Git(tools.git, this.opts.env);
    let diff = await git.diffText(run.worktreePath, run.baseCommit, [RUN_JSON_GLOB]);
    if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + '\n… (дифф обрезан, остальное смотри через git diff)';
    const docs = await this.getChangeDocs(run.id);
    const lastTest = run.tests[run.tests.length - 1];
    const prompt = this.prompts.render('review.md', {
      changeId: run.changeId,
      proposal: docs.proposal || '(нет)',
      tasks: docs.tasks || '(нет)',
      specs: docs.specs.map((s) => `### ${s.path}\n\n${s.content}`).join('\n\n') || '(нет)',
      tests: lastTest ? `\`${lastTest.command || '—'}\`: ${lastTest.passed ? 'прошли' : 'не прошли'}` : 'не запускались',
      base: run.baseCommit.slice(0, 8),
      diff: diff || '(пусто)',
      attachments: [
        run.attachments?.length ? 'К задаче приложены изображения (макеты, скриншоты) — они прикреплены к этому сообщению. Сверь реализацию с ними.' : '',
        run.visuals?.length ? 'Также прикреплены скриншоты приложения после изменений (визуальная проверка). Учитывай видимый результат.' : '',
      ].filter(Boolean).join('\n'),
    });

    const res = await runCodex({
      ...this.agentBase(run, tools.codex),
      prompt,
      model: run.models.reviewer,
      sandbox: 'read-only',
      images: [...(run.attachments ?? []), ...((run.visuals?.at(-1)?.shots ?? []).slice(0, 6).map((x) => x.file))],
      outputSchema: this.prompts.json<object>('review.schema.json'),
    });
    this.afterAgent(run, attempt, res);

    const parsed = parseReview(res.text);
    if (!parsed) {
      throw new Error(`Ревьюер вернул ответ не в формате JSON { blocking, notes }:\n${res.text.slice(0, 500)}`);
    }
    const review: ReviewResult = { at: new Date().toISOString(), ...parsed };
    run.reviews.push(review);
    this.emit({ type: 'review.result', runId: run.id, result: review });
    const fmt = (i: ReviewItem) => `${i.file ? `${i.file}${i.line ? ':' + i.line : ''} — ` : ''}${i.message}`;
    if (review.blocking.length) this.log(run, c.coral(`✗ блокирующие замечания (${review.blocking.length}):\n`) + review.blocking.map((i) => `  • ${fmt(i)}`).join('\n') + '\n');
    if (review.notes.length) this.log(run, c.amber(`• заметки (${review.notes.length}):\n`) + review.notes.map((i) => `  • ${fmt(i)}`).join('\n') + '\n');
    this.end(run, attempt, review.blocking.length ? 'failed' : 'done', review.blocking.length ? `Блокирующих: ${review.blocking.length}` : `Без блокирующих, заметок: ${review.notes.length}`);

    if (!review.blocking.length) {
      run.next = 'gate2';
      run.feedback = undefined;
      this.save(run);
      return;
    }
    run.feedback = {
      source: 'review',
      text: 'Ревьюер (другая модель) нашёл блокирующие проблемы. Исправь каждую:\n' + review.blocking.map((i) => `- ${fmt(i)}`).join('\n')
        + (review.notes.length ? '\n\nНеобязательные заметки:\n' + review.notes.map((i) => `- ${fmt(i)}`).join('\n') : ''),
    };
    this.nextImplementOrLimit(run, `Ревьюер оставил блокирующие замечания, а ${run.implAttemptsUsed} попытки реализации исчерпаны.`);
  }

  private async stageFinish(run: RunFile) {
    const tools = await this.tools(['git', 'openspec']);
    const attempt = this.begin(run, 'finish');
    const openspec = new OpenSpec(tools.openspec, this.opts.env);
    const git = new Git(tools.git, this.opts.env);

    // Повтор после сбоя на коммите: архив уже сделан — второй раз openspec archive не запускаем.
    if (modeOf(run) !== 'quick' && (!run.archivedPath || !fs.existsSync(path.dirname(run.archivedPath)))) {
      this.log(run, c.sky(`$ openspec archive ${run.changeId} -y`) + '\n');
      const archivedDir = await openspec.archive(run.worktreePath, run.changeId, run.id);
      run.archivedPath = path.join(archivedDir, 'run.json');
      this.log(run, c.dim(`архив: ${path.relative(run.worktreePath, archivedDir)}`) + '\n');
    }

    // Финальное состояние пишем до коммита, чтобы в ветке лежал полный run.json.
    this.end(run, attempt, 'done', `Коммит в ${run.branch}`);
    run.status = 'finished';
    run.finishedAt = new Date().toISOString();
    run.next = 'finish';
    this.save(run);
    let sha: string;
    try {
      // Быстрая правка идёт без OpenSpec: run.json остаётся в данных прогона, но не в коммите проекта.
      const exclude = modeOf(run) === 'quick' && RunStore.inProject(run) ? [path.relative(run.worktreePath, RunStore.runJsonPath(run)).split(path.sep).join('/')] : [];
      sha = await git.commitAll(run.worktreePath, `psflow: ${run.changeId}\n\n${run.task}\n\n${modeOf(run) === 'quick' ? '' : `OpenSpec change: ${run.changeId}\n`}PurpleFlow run: ${run.id}`, exclude);
    } catch (e) {
      // Коммит не прошёл — прогон не завершён: возвращаем статус и честно помечаем попытку.
      run.status = 'running';
      run.finishedAt = undefined;
      Object.assign(attempt, { status: 'running', endedAt: undefined, summary: undefined });
      throw e;
    }
    run.commit = sha;
    this.save(run);
    this.log(run, c.mint(`✓ коммит ${sha.slice(0, 8)} в ветке ${run.branch}. Слияние — за вами.`) + '\n');
    if (run.workspace === 'branch') {
      this.log(run, c.dim(`Проект остался на ветке ${run.branch} — можно посмотреть результат.${run.originalBranch ? ` Вернуться: git checkout ${run.originalBranch}` : ''}`) + '\n');
    }
    this.emit({ type: 'run.updated', run });
    this.emit({ type: 'run.finished', runId: run.id, status: 'finished' });
  }

  // ——— Вспомогательное ———

  private nextImplementOrLimit(run: RunFile, limitMessage: string) {
    if (run.implAttemptsUsed < run.implAttemptsLimit) {
      run.next = 'implement';
      this.save(run);
      return;
    }
    run.next = 'limit';
    run.message = `${limitMessage} Дать ещё одну попытку или остановить прогон?`;
    this.save(run);
  }

  private gateMessage(run: RunFile): string | undefined {
    if (run.next === 'limit') return run.message ?? 'Попытки реализации исчерпаны. Дать ещё одну попытку?';
    if (run.next === 'gate1' && modeOf(run) === 'bug') return 'Баг воспроизведён падающим тестом. Причина и план исправления верны?';
    if (run.next === 'gate1' && modeOf(run) === 'epic') return 'Проверьте design.md, этапы в tasks.md и proposal. Принять дизайн?';
    if (run.next === 'gate1') return 'Проверьте proposal и tasks. Принять, вернуть с комментарием или отменить?';
    if (run.next === 'gate2') return 'Посмотрите дифф и замечания ревью. Принять или вернуть на доработку?';
    return undefined;
  }

  private waitGate(run: RunFile, gate: GateId, message?: string) {
    const open = run.attempts.find((a) => a.stage === gate && a.status === 'running');
    if (!open) this.begin(run, gate);
    run.status = 'waiting';
    run.next = gate;
    run.message = message;
    this.save(run);
    this.log(run, c.amber(`◆ ${STAGE_TITLES[gate]}: ждём решения человека`) + '\n');
    this.emit({ type: 'gate.waiting', runId: run.id, gate, message });
  }

  private begin(run: RunFile, stage: StageId, model?: string): StageAttempt {
    const n = run.attempts.filter((a) => a.stage === stage).length + 1;
    const a: StageAttempt = { stage, attempt: n, startedAt: new Date().toISOString(), status: 'running', model: model || undefined };
    run.attempts.push(a);
    this.save(run);
    if (!isGate(stage)) this.log(run, '\n' + c.violet(c.bold(`━━ ${STAGE_TITLES[stage]} · попытка ${n}`)) + '\n');
    this.emit({ type: 'stage.started', runId: run.id, stage, attempt: n });
    return a;
  }

  private end(run: RunFile, a: StageAttempt, status: StageAttempt['status'], summary?: string, error?: string) {
    a.status = status;
    a.endedAt = new Date().toISOString();
    if (summary) a.summary = summary;
    if (error) a.error = error;
    this.save(run);
  }

  /** Общая обработка результата агента: токены, остановка, ошибка. */
  private afterAgent(run: RunFile, a: StageAttempt, res: AgentResult) {
    a.tokens = addUsage(a.tokens ?? emptyUsage(), res.usage);
    run.totals = addUsage(run.totals, res.usage);
    this.save(run);
    if (res.stopped || this.stopping.has(run.id)) throw new StopSignal();
    if (!res.ok) throw new Error(res.error ?? 'Агент завершился с ошибкой');
  }

  private checkStop(run: RunFile) {
    if (this.stopping.has(run.id)) throw new StopSignal();
  }

  private markStopped(run: RunFile, message: string) {
    for (const a of run.attempts) if (a.status === 'running' && !isGate(a.stage)) Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
    run.status = 'stopped';
    run.message = message;
    this.save(run);
    this.log(run, c.amber(`■ ${message}`) + '\n');
    this.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message });
  }

  private fail(run: RunFile, error: string) {
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
  private modeRules(role: 'planner' | 'executor' | 'review' | 'visual', run: RunFile): string {
    const file = `${role}.${modeOf(run)}.md`;
    try {
      return '\n\n' + this.prompts.raw(file);
    } catch {
      return '';
    }
  }

  /** Шаблон промпта режима, если есть (implement.quick.md), иначе общий. */
  private tpl(base: string, run: RunFile): string {
    const name = `${base}.${modeOf(run)}.md`;
    try {
      this.prompts.raw(name);
      return name;
    } catch {
      return `${base}.md`;
    }
  }

  private phaseBlock(run: RunFile): string {
    if (modeOf(run) !== 'epic' || !run.phases) return '';
    return `\n## Этап ${run.phase ?? 1} из ${run.phases}\n\nВыполни только пункты раздела «## ${run.phase ?? 1}.» в tasks.md. Следующие этапы не трогай — они будут отдельными шагами после проверок.\n`;
  }

  private feedbackBlock(f?: Feedback): string {
    if (!f) return '';
    const source = { validator: 'валидатор OpenSpec', tests: 'тесты', review: 'ревьюер', human: 'человек' }[f.source];
    const lines = f.lineComments?.length
      ? '\nЗамечания на строках:\n' + f.lineComments.map((l) => `- ${l.file}:${l.line} — ${l.text}`).join('\n')
      : '';
    return this.prompts.render('feedback.md', { source, text: f.text, lineComments: lines });
  }

  private agentBase(run: RunFile, bin: string, openspecBin?: string) {
    const s = this.opts.getSettings();
    // Агенту нужен тот же openspec, что и ядру.
    const env = openspecBin ? prependPath(this.opts.env, path.dirname(openspecBin)) : this.opts.env;
    return {
      bin,
      cwd: run.worktreePath,
      env,
      timeoutMs: Math.max(1, s.agentTimeoutMin) * 60_000,
      group: run.id,
      onOutput: (text: string) => this.log(run, text, false),
      proxy: s.proxy.baseUrl ? s.proxy : undefined,
      claudeAuth: s.claudeAuth,
      addDirs: run.attachments?.length ? [path.dirname(run.attachments[0])] : undefined,
    };
  }

  private attachmentsDir(id: string): string {
    return path.join(this.opts.dataDir, 'attachments', id);
  }

  /** Изображения задачи — в каталог данных приложения, чтобы не попасть в коммит репозитория. */
  private saveAttachments(id: string, files: { name: string; data: Uint8Array }[]): string[] {
    if (!files.length) return [];
    const dir = this.attachmentsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    return files.map((f, i) => {
      const ext = (path.extname(f.name) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '');
      const base = path.basename(f.name, path.extname(f.name)).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'image';
      const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${base}${ext}`);
      fs.writeFileSync(file, Buffer.from(f.data));
      return file;
    });
  }

  private attachmentsBlock(run: RunFile): string {
    if (!run.attachments?.length) return '';
    return `\nК задаче приложены изображения (макеты, скриншоты). Открой их инструментом Read и учитывай:\n${run.attachments.map((p) => `- ${p}`).join('\n')}\n`;
  }

  /** Вложение для показа в окне: data URL. */
  getAttachment(id: string, index: number): string | null {
    const r = this.mustLoad(id);
    const file = r.attachments?.[index];
    if (!file || !fs.existsSync(file)) return null;
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext || 'png'}`;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  }

  private shell(run: RunFile, command: string, timeoutMin: number) {
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

  private log(run: RunFile, text: string, convert = true) {
    const t = convert ? crlf(text) : text;
    this.store.appendLog(run.id, t);
    this.emit({ type: 'agent.output', runId: run.id, stage: run.next, text: t });
  }

  private save(run: RunFile) {
    this.store.save(run);
    this.emit({ type: 'run.updated', run: structuredClone(run) });
  }

  private mustLoad(id: string): RunFile {
    const r = this.store.load(id);
    if (!r) throw new Error('Прогон не найден');
    return r;
  }

  private async tools(need: (keyof Tools)[]): Promise<Tools> {
    const manual = this.opts.getSettings().toolPaths;
    const found = await detectTools(this.opts.env, manual);
    const missing = need.filter((n) => !found[n].path || found[n].error);
    if (missing.length) {
      throw new Error(`Не найдены: ${missing.join(', ')}. Укажите пути в настройках.`);
    }
    return { git: found.git.path!, claude: found.claude.path!, codex: found.codex.path!, openspec: found.openspec.path! };
  }
}

function isGate(s: StageId): boolean {
  return s === 'gate1' || s === 'gate2' || s === 'limit';
}

/** Название изменения от планировщика: первая строка proposal.md вида «# Название». */
export function planTitle(proposal: string): string | null {
  const m = proposal.match(/^\s*#\s+(.+?)\s*$/m);
  if (!m || /^(why|what changes|impact)$/i.test(m[1])) return null;
  const t = m[1].replace(/^(change|изменение)\s*:\s*/i, '').replace(/[`*]/g, '').trim();
  return t ? (t.length > 72 ? t.slice(0, 70) + '…' : t) : null;
}

const CHECK_NAME = { lint: 'линтер', test: 'тесты' } as const;

/** Свободный TCP-порт на localhost. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Ждём, пока адрес начнёт отвечать (любой HTTP-ответ), или пока процесс не умрёт. */
async function waitForUrl(url: string, timeoutMs: number, abort: () => boolean): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (abort()) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(timer);
      return true;
    } catch { /* ещё не поднялось */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** «shots» из JSON-ответа визуальной проверки. */
export function parseShots(text: string): { file: string; caption: string }[] {
  try {
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return Array.isArray(j.shots)
      ? j.shots.filter((x: { file?: unknown }) => typeof x?.file === 'string').map((x: { file: string; caption?: unknown }) => ({ file: x.file, caption: String(x.caption ?? '') }))
      : [];
  } catch {
    return [];
  }
}

/** Число этапов большой задачи — разделы «## N.» в tasks.md. */
export function countPhases(tasks: string): number {
  return (tasks.match(/^##\s+\d+\./gm) ?? []).length;
}

function firstLine(s: string): string {
  const line = s.trim().split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/^[#>*\-\s]+/, '').slice(0, 160);
}

/** Достаём { blocking, notes } даже если модель обернула JSON в текст или ```json. */
export function parseReview(text: string): { blocking: ReviewItem[]; notes: ReviewItem[] } | null {
  const candidates: string[] = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const cand of candidates) {
    try {
      const j = JSON.parse(cand);
      if (j && Array.isArray(j.blocking) && Array.isArray(j.notes)) {
        const norm = (x: unknown): ReviewItem =>
          typeof x === 'string'
            ? { file: null, line: null, message: x }
            : {
                file: (x as ReviewItem).file ?? null,
                line: typeof (x as ReviewItem).line === 'number' ? (x as ReviewItem).line : null,
                message: String((x as ReviewItem).message ?? JSON.stringify(x)),
              };
        return { blocking: j.blocking.map(norm), notes: j.notes.map(norm) };
      }
    } catch { /* следующий кандидат */ }
  }
  return null;
}
