import crypto from 'node:crypto';
import fs from 'node:fs';
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
import type {
  ConnectionCheck, CoreCommand, CoreEvent, CoreSettings, DiffFile, Feedback, GateId, LineComment, ReviewItem,
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
  tests: 'Тесты',
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
    }
  }

  /** После перезапуска приложения: прогоны, оборванные посреди стадии, помечаются остановленными. */
  async recover(): Promise<void> {
    for (const s of this.store.list()) {
      // Агенты и тесты, пережившие аварийный выход приложения, не должны писать в worktree параллельно с повтором стадии.
      const orphans = this.store.readPids(s.id);
      if (orphans.length) {
        await Promise.all(orphans.map(killPid));
        this.store.writePids(s.id, []);
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
    return git.diff(r.worktreePath, r.baseCommit, (p) => p.startsWith('openspec/changes/') && p.endsWith('/run.json'));
  }

  /** proposal.md, tasks.md и дельты спецификаций — для гейта 1 и ревью. */
  getChangeDocs(id: string): { proposal: string; tasks: string; design: string; specs: { path: string; content: string }[] } {
    const r = this.mustLoad(id);
    const dir = r.archivedPath ? path.dirname(r.archivedPath) : path.join(r.worktreePath, 'openspec', 'changes', r.changeId);
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
      const base = { bin: tools[agent], cwd: dir, env: this.opts.env, prompt, model, timeoutMs: 120_000, group: `check-${agent}`, onOutput: () => {}, proxy };
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
    const worktreePath = path.join(this.store.worktreesDir(), `${path.basename(repo)}-${changeId}`);
    await git.addWorktree(repo, worktreePath, branch, base);

    const openspec = new OpenSpec(tools.openspec, this.opts.env);
    await openspec.ensureInit(worktreePath, 'init');

    const now = new Date().toISOString();
    const run: RunFile = {
      version: 1,
      id: crypto.randomUUID(),
      changeId,
      title: makeTitle(input.task),
      task: input.task.trim(),
      projectPath: repo,
      worktreePath,
      branch,
      baseCommit: base,
      testCommand: input.testCommand.trim(),
      setupCommand: input.setupCommand?.trim() || undefined,
      prepared: !input.setupCommand?.trim(),
      models: { ...s.models },
      status: 'running',
      next: 'plan',
      attempts: [],
      planRetries: 0,
      implAttemptsUsed: 0,
      implAttemptsLimit: IMPL_LIMIT,
      tests: [],
      reviews: [],
      gates: [],
      totals: emptyUsage(),
      createdAt: now,
      updatedAt: now,
    };
    this.save(run);
    this.log(run, c.dim(`PS Flow · ${run.changeId}\nветка ${branch} от ${base.slice(0, 8)}\nworktree ${worktreePath}\n`));
    void this.drive(run);
    return run.id;
  }

  private async resume(id: string) {
    if (this.driving.has(id)) return;
    const r = this.mustLoad(id);
    if (r.status === 'finished' || r.status === 'cancelled') throw new Error('Прогон уже завершён');
    r.message = undefined;
    if (r.next === 'plan') r.planRetries = 0;
    if (isGate(r.next)) return this.waitGate(r, r.next as GateId, this.gateMessage(r));
    r.status = 'running';
    this.save(r);
    void this.drive(r);
  }

  private async stop(id: string) {
    const r = this.store.load(id);
    if (!r) return;
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
      testCommand: run.testCommand || 'не задана',
      feedback: this.feedbackBlock(run.feedback),
    });
    const res = await runClaude({
      ...this.agentBase(run, tools.claude, tools.openspec),
      prompt,
      systemPrompt: this.prompts.raw('planner.system.md'),
      model: run.models.planner,
    });
    this.afterAgent(run, attempt, res);

    const openspec = new OpenSpec(tools.openspec, this.opts.env);
    const v = await openspec.validate(run.worktreePath, run.changeId, run.id);
    this.checkStop(run);
    if (v.valid) {
      this.log(run, c.mint('✓ openspec validate: изменение валидно') + '\n');
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
    const prompt = this.prompts.render('implement.md', {
      changeId: run.changeId,
      task: run.task,
      testCommand: run.testCommand || 'не задана',
      attempt: run.implAttemptsUsed,
      limit: run.implAttemptsLimit,
      feedback: this.feedbackBlock(run.feedback),
    });
    let res: AgentResult;
    try {
      res = await runClaude({
        ...this.agentBase(run, tools.claude, tools.openspec),
        prompt,
        systemPrompt: this.prompts.raw('executor.system.md'),
        model: run.models.executor,
      });
      this.afterAgent(run, attempt, res);
    } catch (e) {
      // Сбой агента (ключ, токены, таймаут) не тратит попытку реализации.
      run.implAttemptsUsed--;
      throw e;
    }
    this.end(run, attempt, 'done', firstLine(res.text) || 'Реализация выполнена');
    run.next = 'tests';
    this.save(run);
  }

  private async stageTests(run: RunFile) {
    const s = this.opts.getSettings();
    const attempt = this.begin(run, 'tests');
    let result: TestResult;
    if (!run.testCommand) {
      result = { at: new Date().toISOString(), command: '', passed: true, exitCode: 0, durationMs: 0, output: 'Команда тестов не задана — стадия пропущена.' };
      this.log(run, c.amber(result.output) + '\n');
    } else {
      this.log(run, c.sky(`$ ${run.testCommand}`) + '\n');
      const r = await this.shell(run, run.testCommand, s.testTimeoutMin);
      this.checkStop(run);
      const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
      result = {
        at: new Date().toISOString(),
        command: run.testCommand,
        passed: r.code === 0 && !r.timedOut,
        exitCode: r.code,
        durationMs: r.durationMs,
        output: output.length > MAX_TEST_OUTPUT ? '…\n' + output.slice(-MAX_TEST_OUTPUT) : output,
        timedOut: r.timedOut || undefined,
      };
      if (r.spawnError) result.output = `Не удалось запустить: ${r.spawnError}`;
    }
    run.tests.push(result);
    this.emit({ type: 'tests.result', runId: run.id, result });
    this.log(run, (result.passed ? c.mint('✓ тесты зелёные') : c.coral(`✗ тесты красные (код ${result.exitCode}${result.timedOut ? ', таймаут' : ''})`)) + '\n');
    this.end(run, attempt, result.passed ? 'done' : 'failed', result.passed ? 'Зелёные' : `Красные, код ${result.exitCode}`);

    if (result.passed) {
      run.next = 'review';
      this.save(run);
      return;
    }
    run.feedback = {
      source: 'tests',
      text: `Тесты не прошли. Команда: \`${run.testCommand}\`, код выхода ${result.exitCode}${result.timedOut ? ' (таймаут)' : ''}.\n\nВывод:\n\`\`\`\n${result.output}\n\`\`\``,
    };
    this.nextImplementOrLimit(run, `Тесты красные после ${run.implAttemptsUsed} попыток реализации.`);
  }

  private async stageReview(run: RunFile) {
    const tools = await this.tools(['git', 'codex']);
    const attempt = this.begin(run, 'review', run.models.reviewer);
    const git = new Git(tools.git, this.opts.env);
    let diff = await git.diffText(run.worktreePath, run.baseCommit, [RUN_JSON_GLOB]);
    if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + '\n… (дифф обрезан, остальное смотри через git diff)';
    const docs = this.getChangeDocs(run.id);
    const lastTest = run.tests[run.tests.length - 1];
    const prompt = this.prompts.render('review.md', {
      changeId: run.changeId,
      proposal: docs.proposal || '(нет)',
      tasks: docs.tasks || '(нет)',
      specs: docs.specs.map((s) => `### ${s.path}\n\n${s.content}`).join('\n\n') || '(нет)',
      tests: lastTest ? `\`${lastTest.command || '—'}\`: ${lastTest.passed ? 'прошли' : 'не прошли'}` : 'не запускались',
      base: run.baseCommit.slice(0, 8),
      diff: diff || '(пусто)',
    });

    const res = await runCodex({
      ...this.agentBase(run, tools.codex),
      prompt,
      model: run.models.reviewer,
      sandbox: 'read-only',
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
    if (!run.archivedPath || !fs.existsSync(path.dirname(run.archivedPath))) {
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
    const sha = await git.commitAll(run.worktreePath, `psflow: ${run.changeId}\n\n${run.task}\n\nOpenSpec change: ${run.changeId}\nPS Flow run: ${run.id}`);
    this.log(run, c.mint(`✓ коммит ${sha.slice(0, 8)} в ветке ${run.branch}. Слияние — за вами.`) + '\n');
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
    };
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
