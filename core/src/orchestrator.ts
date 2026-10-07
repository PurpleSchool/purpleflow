import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from './agents/claude.js';
import { runCodex } from './agents/codex.js';
import { addUsage, c, crlf, emptyUsage, type AgentResult } from './agents/common.js';
import { detectTools, prependPath, which } from './env.js';
import { createPr, mergePr, prReadiness, prStatus, pushBranch } from './github.js';
import { Git } from './git.js';
import { makeChangeId, makeTitle } from './ids.js';
import { OpenSpec } from './openspec.js';
import { killGroup, killPid, run as runProc, setPidTracker } from './proc.js';
import { Prompts } from './prompts.js';
import { RunStore } from './store.js';
import { Screencast, findChrome, waitForCdp } from './screencast.js';
import { projectStats } from './stats.js';
import { browserLeftovers, screenshots, sizeOfAll, subdirs } from './storage.js';
import { MODE_FIRST, MODE_LIMIT, QUICK_REVIEW_LINES, TEST_FILE, modeOf } from './modes.js';
import { DEFAULT_AGENTS } from './types.js';
import type {
  AgentKind, Role, PrStatus, ProjectListItem, ProjectOverview, ProjectStats, ProjectKnowledge, ClarifyQuestion, AiCommands, CheckResult, ModeSuggestion, PreviewState, StorageItem, ProjectConfig, RunMode, VisualResult, ConnectionCheck, CoreCommand, CoreEvent, CoreSettings, DiffFile, Feedback, GateId, LineComment, ReviewItem,
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
  clarify: 'Уточнение',
  gate0: 'Ответы на вопросы',
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
      case 'run.merge':
        await this.merge(cmd.runId, cmd.target);
        return { runId: cmd.runId };
      case 'run.pr':
        await this.openPr(cmd.runId, cmd.base);
        return { runId: cmd.runId };
      case 'run.prMerge':
        await this.mergePrOf(cmd.runId);
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
      for (const a of r.attempts) if (a.status === 'running') Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
      // Оборванная реализация — не вина исполнителя: попытку возвращаем.
      if (r.next === 'implement' && r.implAttemptsUsed > 0) r.implAttemptsUsed--;
      r.status = 'stopped';
      r.message = 'Прервано: приложение было закрыто. Нажмите «Продолжить», чтобы повторить текущую стадию.';
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
    const env = new Set(this.envFilesOf(r));
    const skip = (p: string) => (p.startsWith('openspec/') && p.endsWith('/run.json')) || env.has(p);
    // Завершённый прогон — дифф ветки прогона: рабочая копия могла уйти на другую ветку.
    if (r.status === 'finished') return git.diffCommits(r.projectPath, r.baseCommit, r.branch, skip);
    return git.diff(r.worktreePath, r.baseCommit, skip);
  }

  /**
   * Удалить прогон. Сначала гасим всё живое (агент, сервер, предпросмотр), потом worktree,
   * по желанию — ветку, и данные в каталоге приложения. Рабочая копия проекта в режиме «ветка» не трогается.
   */
  private async deleteRun(id: string, deleteBranch: boolean) {
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

  private runsWithFiles(): RunFile[] {
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

  private ghBin(): string | null {
    return which('gh', this.opts.env);
  }

  /** null — PR создать можно; иначе причина, почему нет (нет gh, origin не на GitHub…). */
  async prReady(id: string): Promise<string | null> {
    const r = this.mustLoad(id);
    const tools = await this.tools(['git']);
    return prReadiness(this.ghBin(), tools.git, r.projectPath, this.opts.env);
  }

  private async openPr(id: string, base: string) {
    const r = this.mustLoad(id);
    if (r.status !== 'finished') throw new Error('PR можно открыть только для завершённого прогона');
    if (r.pr) throw new Error(`PR уже открыт: ${r.pr.url}`);
    if (!base.trim()) throw new Error('Выберите ветку, в которую открыть PR');
    const tools = await this.tools(['git']);
    const gh = this.ghBin();
    const why = await prReadiness(gh, tools.git, r.projectPath, this.opts.env);
    if (why || !gh) throw new Error(why ?? 'Нет gh');
    this.log(r, c.sky(`$ git push -u origin ${r.branch}`) + '\n');
    await pushBranch(tools.git, r.projectPath, r.branch, this.opts.env);
    const bodyFile = path.join(os.tmpdir(), `psflow-pr-${r.id}.md`);
    fs.writeFileSync(bodyFile, await this.prBody(r));
    try {
      const pr = await createPr(gh, r.projectPath, this.opts.env, { base, head: r.branch, title: r.title, bodyFile });
      r.pr = { ...pr, base, createdAt: new Date().toISOString() };
      this.save(r);
      this.log(r, c.mint(`✓ PR #${pr.number}: ${pr.url}`) + '\n');
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  }

  /** Описание PR: задача, итог исполнителя, план, проверки, ревью и визуальная проверка — из прогона. */
  private async prBody(r: RunFile): Promise<string> {
    const docs = await this.getChangeDocs(r.id).catch(() => null);
    const impl = [...r.attempts].reverse().find((a) => a.stage === 'implement' && a.output)?.output;
    const lastTest = r.tests.at(-1);
    const review = r.reviews.at(-1);
    const visual = r.visuals?.at(-1);
    const parts: string[] = [`## Задача\n\n${r.task}`];
    if (impl) parts.push(`## Что сделано\n\n${impl.slice(0, 4000)}`);
    if (docs?.proposal) parts.push(`## План (OpenSpec \`${r.changeId}\`)\n\n${docs.proposal.replace(/^#\s+.*\n+/, '').slice(0, 4000)}`);
    if (lastTest?.checks?.length) {
      parts.push(`## Проверки\n\n${lastTest.checks.map((x) => `- ${x.kind === 'lint' ? 'Линтер' : 'Тесты'}: ${x.passed ? '✅' : x.preexisting ? '⚠️ красные и до задачи, новых ошибок нет' : '❌'} \`${x.command}\``).join('\n')}`);
    }
    if (review) {
      const notes = review.notes.map((n) => `- ${n.file ? `\`${n.file}${n.line ? ':' + n.line : ''}\` — ` : ''}${n.message}`).join('\n');
      parts.push(`## Ревью (${r.agents?.reviewer ?? 'codex'})\n\n${review.blocking.length ? `Блокирующих: ${review.blocking.length}` : 'Блокирующих замечаний нет.'}${notes ? `\n\nЗаметки:\n${notes}` : ''}`);
    }
    if (visual) {
      parts.push(`## Визуальная проверка\n\n${visual.unverified ? `⚠️ Проверить не удалось: ${visual.unverified}` : visual.blocking.length ? `Проблем: ${visual.blocking.length}` : '✅ В браузере всё выглядит верно'}${visual.shots.length ? `\n\nСкриншоты (${visual.shots.length}) — в PurpleFlow:\n${visual.shots.map((s) => `- ${s.caption}`).join('\n')}` : ''}`);
    }
    parts.push(`---\nСделано в PurpleFlow · режим «${modeOf(r)}» · прогон \`${r.id.slice(0, 8)}\``);
    return parts.join('\n\n');
  }

  async getPrStatus(id: string): Promise<PrStatus | null> {
    const r = this.mustLoad(id);
    const gh = this.ghBin();
    if (!r.pr || !gh) return null;
    const st = await prStatus(gh, r.projectPath, this.opts.env, r.pr.url);
    // Влили на GitHub (из приложения или руками) — отмечаем у прогона.
    if (st.state === 'MERGED' && !r.merged) {
      r.merged = { into: r.pr.base, commit: st.mergeCommit ?? '', at: new Date().toISOString() };
      this.save(r);
    }
    return st;
  }

  private async mergePrOf(id: string) {
    const r = this.mustLoad(id);
    const gh = this.ghBin();
    if (!r.pr || !gh) throw new Error('У прогона нет PR');
    await mergePr(gh, r.projectPath, this.opts.env, r.pr.url);
    this.log(r, c.mint(`✓ PR #${r.pr.number} влит в ${r.pr.base}`) + '\n');
    await this.getPrStatus(id);
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
      // Модель — из первой роли, которую выполняет этот агент.
      const agents = { ...DEFAULT_AGENTS, ...s.agents };
      const role = (['planner', 'executor', 'reviewer'] as Role[]).find((x) => agents[x] === agent);
      const model = role ? s.models[role] : '';
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
    if (workspace === 'branch') {
      // В режиме «ветка» прогон занимает рабочую копию проекта целиком — второй в том же проекте ей бы помешал.
      const busy = this.runsWithFiles().find((r) => r.workspace === 'branch' && path.resolve(r.projectPath) === path.resolve(repo) && ['running', 'waiting', 'queued'].includes(r.status));
      if (busy) throw new Error(`В режиме «Ветка» в проекте уже идёт «${busy.title}». Дождитесь его или выберите отдельную копию (worktree).`);
    }
    const worktreePath = workspace === 'branch' ? repo : path.join(this.store.worktreesDir(), `${path.basename(repo)}-${changeId}`);
    const mode = input.mode ?? 'task';
    const visual = Boolean(input.visual && input.runCommand?.trim() && input.appUrl?.trim());
    const queued = this.activeCount() >= this.maxParallel();

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
      workspacePending: true,
      visual: visual || undefined,
      // Команда запуска нужна и визуальной стадии, и ручной проверке во вкладке «Браузер».
      runCommand: input.runCommand?.trim() || undefined,
      appUrl: input.appUrl?.trim() || undefined,
      visualNotes: input.visualNotes?.trim() || undefined,
      envFiles: input.envFiles?.map((f) => f.trim()).filter(Boolean),
      // В режиме «ветка» зависимости — уже установленные пользователем; подготовку не запускаем.
      prepared: workspace === 'branch' || !input.setupCommand?.trim(),
      models: { ...s.models },
      agents: { ...DEFAULT_AGENTS, ...s.agents },
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

  /** Рабочая копия прогона: worktree или новая ветка в проекте, OpenSpec, файлы окружения. Для очереди — в момент старта. */
  private async prepareWorkspace(run: RunFile) {
    const tools = await this.tools(['git', 'openspec']);
    const git = new Git(tools.git, this.opts.env);
    if (run.workspace === 'branch') {
      // Чужие незакоммиченные правки попали бы в коммит прогона — поэтому только с чистой копией.
      const dirty = await git.dirtyFiles(run.projectPath);
      if (dirty.length) {
        throw new Error(`В рабочей копии есть незакоммиченные изменения (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? '…' : ''}). Закоммитьте или спрячьте их (git stash) — или выберите отдельную копию (worktree).`);
      }
      run.originalBranch = (await git.currentBranch(run.projectPath)) ?? undefined;
      await git.checkoutNewBranch(run.projectPath, run.branch, run.baseCommit);
    } else {
      await git.addWorktree(run.projectPath, run.worktreePath, run.branch, run.baseCommit);
    }
    if (modeOf(run) !== 'quick') await new OpenSpec(tools.openspec, this.opts.env).ensureInit(run.worktreePath, 'init');
    run.workspacePending = undefined;
    this.save(run);
    this.copyEnvFiles(run);
    this.log(run, c.dim(`PurpleFlow · ${run.changeId}\nветка ${run.branch} от ${run.baseCommit.slice(0, 8)}\n${run.workspace === 'branch' ? `рабочая копия проекта ${run.projectPath} (была ветка ${run.originalBranch ?? 'detached HEAD'})` : `worktree ${run.worktreePath}`}\n`));
  }

  // ——— Очередь: сколько прогонов агенты ведут одновременно ———

  /** Настройки поменялись (например, лимит одновременных прогонов) — может, кого-то пора запустить из очереди. */
  settingsChanged() {
    void this.pump();
  }

  private maxParallel(): number {
    return Math.max(1, Math.min(8, this.opts.getSettings().maxParallel ?? 2));
  }

  /** Прогоны, в которых сейчас работают агенты. Ожидание решения человека место не занимает. */
  private activeCount(): number {
    return this.store.list().filter((r) => r.status === 'running').length;
  }

  /** Запустить из очереди столько прогонов, сколько есть свободных мест (старые — первыми). */
  private async pump() {
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

  private pumping = false;

  private async launchQueued(run: RunFile) {
    run.status = 'running';
    run.message = undefined;
    this.save(run);
    try {
      if (run.workspacePending) await this.prepareWorkspace(run);
    } catch (e) {
      run.status = 'stopped';
      run.message = `Не удалось начать прогон: ${(e as Error).message}`;
      this.save(run);
      this.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message: run.message });
      return;
    }
    void this.drive(run);
  }

  private async resume(id: string) {
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
  private async ensureOnBranch(r: RunFile) {
    if (r.workspace !== 'branch') return;
    const tools = await this.tools(['git']);
    const cur = await new Git(tools.git, this.opts.env).currentBranch(r.projectPath);
    if (cur !== r.branch) throw new Error(`Проект сейчас на ветке ${cur ?? 'detached HEAD'}. Переключитесь на ${r.branch} (git checkout ${r.branch}) и продолжите.`);
  }

  // ——— Ручная проверка: приложение из ветки прогона ———

  private previews = new Map<string, PreviewState>();

  getPreview(id: string): PreviewState {
    return this.previews.get(id) ?? { status: 'idle' };
  }

  private setPreview(id: string, state: PreviewState) {
    if (state.status === 'idle') this.previews.delete(id);
    else this.previews.set(id, state);
    this.emit({ type: 'preview.state', runId: id, state });
  }

  /** Поднять приложение в рабочей копии прогона на свободном порту (команды «Запуск приложения» и «Адрес»). */
  async startPreview(id: string): Promise<PreviewState> {
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

    const { port, url, command } = await expandPorts(appUrl, runCommand);
    const group = `${id}:preview`;
    let output = '';
    let exited: number | null | undefined;
    const tail = (t: string) => {
      output = (output + t).slice(-4000);
    };
    this.setPreview(id, { status: 'starting', url, command });
    const server = runProc(command, [], {
      cwd: r.worktreePath,
      env: { ...this.opts.env, PORT: String(port), BROWSER: 'none' },
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

  /** Файлы окружения прогона: явный список или найденные в проекте (у прогонов без списка — из команд проекта). */
  private envFilesOf(run: RunFile): string[] {
    if (run.workspace === 'branch') return [];
    return run.envFiles ?? this.getProjectConfig(run.projectPath)?.envFiles ?? [];
  }

  /** Скопировать .env-файлы проекта в worktree прогона (только недостающие; в режиме «ветка» они и так на месте). */
  private copyEnvFiles(run: RunFile) {
    const files = this.envFilesOf(run);
    const copied: string[] = [];
    for (const rel of files) {
      const from = path.join(run.projectPath, rel);
      const to = path.join(run.worktreePath, rel);
      if (path.relative(run.projectPath, from).startsWith('..') || !fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        copied.push(rel);
      } catch { /* нет доступа — проверки покажут, чего не хватает */ }
    }
    if (copied.length) this.log(run, c.dim(`файлы окружения скопированы в worktree: ${copied.join(', ')}`) + '\n');
  }

  private async stop(id: string) {
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

  private async decide(id: string, decision: 'approve' | 'reject' | 'cancel' | 'accept' | 'fix', comment?: string, lineComments?: LineComment[]) {
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
      // Человек берёт ответственность на себя: красные проверки или замечания ревью — на приёмку, без новых попыток.
      if (gateAttempt) gateAttempt.summary = 'Принято как есть';
      this.log(r, c.amber('→ человек принял результат как есть — к приёмке') + '\n');
      r.next = 'gate2';
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
    // Продолжение старого прогона: файлов окружения в worktree могло ещё не быть.
    this.copyEnvFiles(run);
    try {
      while (run.status === 'running') {
        if (isGate(run.next)) {
          this.waitGate(run, run.next as GateId, this.gateMessage(run));
          break;
        }
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
  private taskText(run: RunFile): string {
    const a = run.clarify?.answers?.filter((x) => x.a.trim());
    if (!a?.length) return run.task;
    return `${run.task}\n\nУточнения от человека:\n${a.map((x) => `- ${x.q} — ${x.a}`).join('\n')}`;
  }

  private async stageClarify(run: RunFile) {
    const attempt = this.begin(run, 'clarify', run.models.planner);
    // Профиль проекта собирается один раз — дальше его получают все агенты.
    await this.ensureProfile(run, attempt);
    const prompt = this.prompts.render('clarify.md', { task: run.task, attachments: this.attachmentsBlock(run) });
    const res = await this.runRole(run, 'planner', { prompt, readOnly: true, outputSchema: this.prompts.json<object>('clarify.schema.json') });
    this.afterAgent(run, attempt, res);
    const questions = parseQuestions(res.text);
    if (!questions.length) {
      this.end(run, attempt, 'done', 'Задача понятна — вопросов нет');
      run.next = 'plan';
      this.save(run);
      return;
    }
    run.clarify = { questions };
    this.log(run, c.amber(`? вопросы планировщика (${questions.length}):\n`) + questions.map((q, i) => `  ${i + 1}. ${q.q}${q.options?.length ? c.dim(` [${q.options.join(' / ')}]`) : ''}`).join('\n') + '\n');
    this.end(run, attempt, 'done', `Вопросов: ${questions.length}`);
    run.next = 'gate0';
    this.save(run);
  }

  private async answer(id: string, answers: { q: string; a: string }[]) {
    const r = this.mustLoad(id);
    if (r.next !== 'gate0' || (r.status !== 'waiting' && r.status !== 'stopped')) throw new Error('Прогон не ждёт ответов на вопросы');
    const clean = answers.map((x) => ({ q: x.q.trim(), a: x.a.trim() })).filter((x) => x.a);
    r.clarify = { questions: r.clarify?.questions ?? [], answers: clean, skipped: clean.length ? undefined : true };
    r.gates.push({ gate: 'gate0', at: new Date().toISOString(), decision: 'approve', comment: clean.map((x) => `${x.q} — ${x.a}`).join('\n') || undefined });
    const gateAttempt = [...r.attempts].reverse().find((a) => a.stage === 'gate0' && a.status === 'running');
    if (gateAttempt) Object.assign(gateAttempt, { status: 'done', endedAt: new Date().toISOString(), summary: clean.length ? `Ответов: ${clean.length}` : 'Без ответов' });
    if (clean.length) this.log(r, c.mint('✓ ответы человека:\n') + clean.map((x) => `  • ${x.q} — ${x.a}`).join('\n') + '\n');
    r.message = undefined;
    r.next = 'plan';
    r.status = 'running';
    this.save(r);
    void this.drive(r);
  }

  // ——— Знания о проекте: профиль и уроки прошлых прогонов ———

  private knowledgeOf(repo: string): ProjectKnowledge {
    return this.getProjectConfig(repo)?.knowledge ?? {};
  }

  private updateKnowledge(repo: string, fn: (k: ProjectKnowledge) => ProjectKnowledge) {
    const all = this.store.readProjects();
    const key = path.resolve(repo);
    const cfg: ProjectConfig = all[key] ?? { setupCommand: '', lintCommand: '', testCommand: '', notes: { setup: '', lint: '', test: '' }, updatedAt: new Date().toISOString() };
    this.store.writeProject(key, { ...cfg, knowledge: fn(cfg.knowledge ?? {}) });
  }

  /** Блок для системного промпта агентов. */
  private knowledgeBlock(run: RunFile): string {
    const k = this.knowledgeOf(run.projectPath);
    const lessons = k.lessons?.map((l) => `- ${l.text}`).join('\n');
    if (!k.profile && !lessons) return '';
    return `\n\n## Знания о проекте\n\nСобраны в прошлых прогонах — опирайся на них, но если код говорит иное, верь коду.${k.profile ? `\n\n### Профиль\n\n${k.profile.trim()}` : ''}${lessons ? `\n\n### Уроки прошлых прогонов\n\n${lessons}` : ''}`;
  }

  private async profileFor(repo: string, cwd: string, onOutput: (t: string) => void, group: string): Promise<AgentResult> {
    const s = this.opts.getSettings();
    const tools = await this.tools(['claude']);
    return runClaude({
      bin: tools.claude, cwd, env: this.opts.env, prompt: this.prompts.raw('profile.md'),
      model: this.claudeModel(s.agents, s.models) || undefined, timeoutMs: 10 * 60_000, group, onOutput,
      proxy: s.proxy.baseUrl ? s.proxy : undefined, claudeAuth: s.claudeAuth, tools: ['Read', 'Glob', 'Grep'],
    });
  }

  /** Профиль проекта — один раз, перед первым планом. Сбой не останавливает прогон. */
  private async ensureProfile(run: RunFile, attempt: StageAttempt) {
    if (this.knowledgeOf(run.projectPath).profile) return;
    this.log(run, c.dim('Изучаю проект для профиля — один раз, дальше он достаётся всем агентам…') + '\n');
    const res = await this.profileFor(run.projectPath, run.worktreePath, (t) => this.log(run, c.dim(t), false), run.id);
    attempt.tokens = addUsage(attempt.tokens ?? emptyUsage(), res.usage);
    run.totals = addUsage(run.totals, res.usage);
    this.checkStop(run);
    if (!res.ok || !res.text.trim()) {
      this.log(run, c.amber(`! профиль проекта не собран: ${res.error ?? 'пустой ответ'} — продолжаю без него`) + '\n');
      return;
    }
    this.updateKnowledge(run.projectPath, (k) => ({ ...k, profile: res.text.trim(), profileAt: new Date().toISOString() }));
    this.log(run, c.mint('✓ профиль проекта сохранён — его можно поправить в «Проекты → Знания о проекте»') + '\n');
  }

  /** Пересобрать профиль по кнопке в «Знаниях о проекте». */
  async refreshProfile(repo: string): Promise<ProjectKnowledge> {
    const res = await this.profileFor(repo, repo, () => {}, `profile-${Date.now()}`);
    if (!res.ok || !res.text.trim()) throw new Error(res.error ?? 'Нейросеть вернула пустой профиль');
    this.updateKnowledge(repo, (k) => ({ ...k, profile: res.text.trim(), profileAt: new Date().toISOString() }));
    return this.knowledgeOf(repo);
  }

  saveKnowledge(repo: string, k: ProjectKnowledge): ProjectKnowledge {
    this.updateKnowledge(repo, () => ({
      profile: k.profile?.trim() || undefined,
      profileAt: k.profileAt,
      lessons: k.lessons?.filter((l) => l.text.trim()).map((l) => ({ ...l, text: l.text.trim() })),
    }));
    return this.knowledgeOf(repo);
  }

  getKnowledge(repo: string): ProjectKnowledge {
    return this.knowledgeOf(repo);
  }

  /** После прогона: уроки из правок человека, ревью, визуальной проверки и сбоев проверок. В фоне, не задерживает коммит. */
  private async learn(run: RunFile) {
    const human = run.gates.filter((g) => (g.decision === 'reject' || g.decision === 'fix') && (g.comment || g.lineComments?.length))
      .map((g) => `- человек (${g.gate === 'gate1' ? 'план' : 'приёмка'}): ${g.comment ?? ''}${g.lineComments?.length ? ' ' + g.lineComments.map((l) => `[${l.file}:${l.line}] ${l.text}`).join('; ') : ''}`);
    const review = run.reviews.flatMap((r) => [...r.blocking, ...r.notes]).slice(0, 12).map((i) => `- ревью: ${i.file ? `${i.file} — ` : ''}${i.message}`);
    const visual = (run.visuals ?? []).flatMap((v) => [...(v.unverified ? [`- визуальная проверка не смогла проверить: ${v.unverified}`] : []), ...v.blocking.map((b) => `- визуальная проверка: ${b.message}`)]);
    const failed = run.tests.filter((t) => !t.passed).slice(0, 3).map((t) => `- проверки упали: ${(t.checks ?? []).filter((x) => !x.passed && !x.preexisting).map((x) => x.command).join(', ')}`);
    const digest = [...human, ...review, ...visual, ...failed].join('\n').slice(0, 6000);
    if (!digest.trim()) return;
    const known = this.knowledgeOf(run.projectPath).lessons ?? [];
    const s = this.opts.getSettings();
    const tools = await this.tools(['claude']).catch(() => null);
    if (!tools) return;
    const res = await runClaude({
      bin: tools.claude, cwd: os.tmpdir(), env: this.opts.env,
      prompt: this.prompts.render('lessons.md', { known: known.map((l) => `- ${l.text}`).join('\n') || '(пока нет)', digest }),
      model: this.claudeModel(s.agents, s.models) || undefined, timeoutMs: 3 * 60_000, group: `${run.id}:learn`, onOutput: () => {},
      proxy: s.proxy.baseUrl ? s.proxy : undefined, claudeAuth: s.claudeAuth, tools: [],
    }).catch(() => null);
    if (!res?.ok) return;
    let lessons: string[] = [];
    try {
      const j = JSON.parse(res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1)) as { lessons?: unknown };
      lessons = Array.isArray(j.lessons) ? j.lessons.filter((x): x is string => typeof x === 'string' && x.trim().length > 3).slice(0, 5) : [];
    } catch { return; }
    const seen = new Set(known.map((l) => l.text.toLowerCase()));
    const fresh = lessons.map((t) => t.trim()).filter((t) => !seen.has(t.toLowerCase()));
    if (!fresh.length) return;
    const at = new Date().toISOString();
    // Не больше 40 уроков: старые уходят первыми.
    this.updateKnowledge(run.projectPath, (k) => ({ ...k, lessons: [...(k.lessons ?? []), ...fresh.map((text) => ({ text, at, runId: run.id }))].slice(-40) }));
    this.log(run, c.violet(`✦ уроки для следующих прогонов (+${fresh.length}):\n`) + fresh.map((t) => `  • ${t}`).join('\n') + '\n');
  }

  private async stagePlan(run: RunFile) {
    // Новый план — новая постановка: прошлая сессия исполнителя к нему не относится.
    run.executorSession = undefined;
    const s = this.opts.getSettings();
    const tools = await this.tools(['openspec']);
    const attempt = this.begin(run, 'plan', run.models.planner);

    if (!run.prepared && run.setupCommand) {
      this.log(run, c.sky(`$ ${run.setupCommand}`) + '\n');
      const r = await this.shell(run, run.setupCommand, s.testTimeoutMin);
      this.checkStop(run);
      if (r.code !== 0) throw new Error(`Команда подготовки «${run.setupCommand}» завершилась с кодом ${r.code}${r.timedOut ? ' (таймаут)' : ''}`);
      run.prepared = true;
      this.save(run);
    }
    await this.captureBaseChecks(run);

    const prompt = this.prompts.render('plan.md', {
      changeId: run.changeId,
      task: this.taskText(run),
      attachments: this.attachmentsBlock(run),
      testCommand: run.testCommand || 'не задана',
      feedback: this.feedbackBlock(run.feedback),
    });
    const res = await this.runRole(run, 'planner', {
      prompt,
      systemPrompt: this.prompts.raw('planner.system.md') + this.modeRules('planner', run),
      openspec: true,
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

    // Быстрая правка идёт без плана: исходные проверки снимаем перед первой реализацией —
    // только пока агент ещё ничего не менял (у прогонов, начатых до этой версии, эталона нет).
    if (!run.attempts.some((x) => x.stage === 'implement')) await this.captureBaseChecks(run);
    run.implAttemptsUsed++;
    const attempt = this.begin(run, 'implement', run.models.executor);
    const prompt = this.prompts.render(this.tpl('implement', run), {
      changeId: run.changeId,
      task: this.taskText(run),
      attachments: this.attachmentsBlock(run),
      testCommand: run.testCommand || 'не задана',
      attempt: run.implAttemptsUsed,
      limit: run.implAttemptsLimit,
      feedback: this.phaseBlock(run) + this.feedbackBlock(run.feedback),
    });
    let res: AgentResult;
    const systemPrompt = this.prompts.raw('executor.system.md') + this.modeRules('executor', run);
    const onClaude = (run.agents?.executor ?? DEFAULT_AGENTS.executor) === 'claude';
    try {
      // Следующая попытка на claude продолжает сессию прошлой: только замечания, без повторного изучения проекта.
      if (onClaude && run.executorSession) {
        this.log(run, c.dim('продолжаю сессию исполнителя — в контексте прошлая попытка') + '\n');
        const short = this.prompts.render('implement-continue.md', {
          changeId: run.changeId,
          testCommand: run.testCommand || 'не задана',
          attempt: run.implAttemptsUsed,
          limit: run.implAttemptsLimit,
          feedback: this.phaseBlock(run) + this.feedbackBlock(run.feedback),
        });
        res = await this.runRole(run, 'executor', { prompt: short, systemPrompt, openspec: true, resume: run.executorSession });
        if (!res.ok && !res.stopped && /no conversation|session|не найден/i.test(res.error ?? '')) {
          // Сессия пропала (чистка ~/.claude, другой компьютер) — начинаем заново с полной постановкой.
          this.log(run, c.dim('сессия не найдена — начинаю заново') + '\n');
          run.executorSession = crypto.randomUUID();
          res = await this.runRole(run, 'executor', { prompt, systemPrompt, openspec: true, sessionId: run.executorSession });
        }
      } else {
        if (onClaude) run.executorSession = crypto.randomUUID();
        res = await this.runRole(run, 'executor', { prompt, systemPrompt, openspec: true, sessionId: onClaude ? run.executorSession : undefined });
      }
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

  private checksFeedback(failed: CheckResult[], base?: CheckResult[]): string {
    return failed.map((x) => {
      const before = base?.find((b) => b.kind === x.kind && !b.passed);
      const head = `${x.kind === 'lint' ? 'Линтер' : 'Тесты'} не прошли. Команда: \`${x.command}\`, код выхода ${x.exitCode}${x.timedOut ? ' (таймаут)' : ''}.`;
      // Проверка была красной и до задачи: просим исправить только новое, чужие старые ошибки не трогать.
      const delta = before
        ? `\n\nЭта проверка была красной ещё до задачи (ошибок: ${errorCount(before.output) ?? 'не удалось посчитать'}), сейчас — ${errorCount(x.output) ?? 'не удалось посчитать'}. Старые ошибки в чужом коде не исправляй — устрани только те, что появились из‑за твоих изменений, чтобы ошибок стало не больше, чем было.`
        : '';
      return `${head}${delta}\n\nВывод:\n\`\`\`\n${x.output}\n\`\`\``;
    }).join('\n\n');
  }

  /** Линтер и тесты на базовом коммите — один раз за прогон, до первых правок агента. */
  private async captureBaseChecks(run: RunFile) {
    if (run.baseChecks || (!run.lintCommand && !run.testCommand)) return;
    this.log(run, c.dim('Исходное состояние проверок (до правок агента):') + '\n');
    const { result } = await this.runChecks(run);
    run.baseChecks = result.checks ?? [];
    const red = run.baseChecks.filter((x) => !x.passed);
    if (red.length) {
      this.log(run, c.amber(`! красные ещё до задачи: ${red.map((x) => `${CHECK_NAME[x.kind]} (ошибок: ${errorCount(x.output) ?? '?'})`).join(', ')} — от агента потребуется не добавлять новых ошибок`) + '\n');
    }
    this.save(run);
  }

  /** Красная проверка, которая была красной и до задачи и ошибок в ней не прибавилось, не блокирует. */
  private compareWithBase(run: RunFile, result: TestResult): { result: TestResult; failed: CheckResult[] } {
    const checks = (result.checks ?? []).map((x) => {
      if (x.passed || x.timedOut) return x;
      const before = run.baseChecks?.find((b) => b.kind === x.kind && b.command === x.command && !b.passed);
      if (!before) return x;
      const a = errorCount(before.output);
      const b = errorCount(x.output);
      // Посчитать не удалось — сравниваем по коду выхода: тот же код считаем «тем же состоянием».
      const same = a != null && b != null ? b <= a : before.exitCode === x.exitCode;
      if (!same) return x;
      this.log(run, c.amber(`! ${CHECK_NAME[x.kind]}: красный и до задачи, новых ошибок нет (${a ?? '?'} → ${b ?? '?'}) — не блокирует`) + '\n');
      return { ...x, preexisting: { before: a, after: b } };
    });
    const failed = checks.filter((x) => !x.passed && !x.preexisting);
    return { result: { ...result, checks, passed: failed.length === 0, exitCode: failed[0]?.exitCode ?? 0 }, failed };
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

    const raw = await this.runChecks(run);
    const { result, failed } = this.compareWithBase(run, raw.result);
    run.tests.push(result);
    this.emit({ type: 'tests.result', runId: run.id, result });
    const checks = result.checks ?? [];
    const summary = !checks.length ? 'Пропущены'
      : failed.length ? `Красные: ${failed.map((x) => CHECK_NAME[x.kind]).join(' и ')}`
      : checks.some((x) => x.preexisting)
        ? checks.map((x) => `${CHECK_NAME[x.kind]}${x.preexisting ? ' — как до задачи' : ' — ok'}`).join(', ').replace(/^./, (m) => m.toUpperCase())
        : checks.map((x) => CHECK_NAME[x.kind]).join(' и ').replace(/^./, (m) => m.toUpperCase()) + ' — ok';
    this.end(run, attempt, result.passed ? 'done' : 'failed', summary);

    if (result.passed) {
      run.feedback = undefined;
      // Большая задача: следующий этап реализации со свежим запасом попыток.
      if (modeOf(run) === 'epic' && run.phases && (run.phase ?? 1) < run.phases) {
        run.phase = (run.phase ?? 1) + 1;
        run.executorSession = undefined;
        run.implAttemptsUsed = 0;
        run.implAttemptsLimit = MODE_LIMIT.epic;
        this.log(run, c.violet(`→ этап ${run.phase} из ${run.phases}`) + '\n');
        run.next = 'implement';
        this.save(run);
        return;
      }
      if (run.quickFix) {
        // Быстрая правка: ревью и визуальная проверка уже были — сразу к человеку.
        run.quickFix = undefined;
        run.next = 'gate2';
      } else {
        run.next = await this.reviewOrAccept(run);
      }
      this.save(run);
      return;
    }
    run.feedback = { source: 'tests', text: this.checksFeedback(failed, run.baseChecks) };
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
    run.baseChecks = result.checks ?? [];
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
    run.next = 'clarify';
    this.save(run);
  }

  /** После проверок — ревью; быстрая правка с маленьким диффом идёт без него (сразу к визуальной проверке или приёмке). */
  private async reviewOrAccept(run: RunFile): Promise<StageId> {
    if (modeOf(run) !== 'quick') return 'review';
    const tools = await this.tools(['git']);
    const diff = await new Git(tools.git, this.opts.env).diffText(run.worktreePath, run.baseCommit, [RUN_JSON_GLOB, ...this.envFilesOf(run)]);
    const lines = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
    if (lines <= QUICK_REVIEW_LINES) {
      this.log(run, c.dim(`Дифф ${lines} строк — ревью пропущено (быстрая правка).`) + '\n');
      return run.visual ? 'visual' : 'gate2';
    }
    return 'review';
  }

  /** Проекты, с которыми работали: настроенные и те, где были прогоны. Сначала недавние. */
  listProjects(): ProjectListItem[] {
    const map = new Map<string, ProjectListItem>();
    for (const [p, cfg] of Object.entries(this.store.readProjects())) {
      map.set(p, { path: p, configured: true, exists: fs.existsSync(p), updatedAt: cfg.updatedAt, runs: 0, active: 0, lastRunAt: null });
    }
    for (const r of this.listRuns()) {
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

  /** Состояние репозитория проекта для страницы «Обзор». */
  async projectOverview(repo: string): Promise<ProjectOverview> {
    const tools = await this.tools(['git']);
    const git = new Git(tools.git, this.opts.env);
    const [branch, dirty, remote, pr] = await Promise.all([
      git.currentBranch(repo).catch(() => null),
      git.dirtyFiles(repo).then((f) => f.length).catch(() => 0),
      runProc(tools.git, ['remote', 'get-url', 'origin'], { cwd: repo, env: this.opts.env, timeoutMs: 10_000 }).then((x) => (x.code === 0 ? x.stdout.trim() : null)).catch(() => null),
      prReadiness(this.ghBin(), tools.git, repo, this.opts.env).catch((e) => String((e as Error).message)),
    ]);
    return { branch, dirty, remote, prReady: pr };
  }

  /** Статистика по прогонам проекта. */
  projectStats(repo: string): ProjectStats {
    const root = path.resolve(repo);
    const runs = this.listRuns()
      .filter((r) => !r.missing && path.resolve(r.projectPath) === root)
      .map((r) => this.store.load(r.id))
      .filter((r): r is RunFile => Boolean(r));
    return projectStats(runs);
  }

  /** Убрать проект из списка: команды и знания удаляются, прогоны остаются. */
  forgetProject(repo: string): void {
    this.store.removeProject(path.resolve(repo));
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
      visualNotes: cfg.visualNotes?.trim() || undefined,
      envFiles: cfg.envFiles?.map((f) => f.trim()).filter(Boolean),
      workspace: cfg.workspace,
      notes: cfg.notes,
      // Знания собираются отдельно — сохранение команд их не трогает.
      knowledge: cfg.knowledge ?? this.getProjectConfig(repo)?.knowledge,
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
      model: this.claudeModel(s.agents, s.models) || undefined,
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
        visualNotes: str(j.visual),
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
      model: this.claudeModel(s.agents, s.models) || undefined,
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
    const attempt = this.begin(run, 'visual', run.models.visual || this.claudeModel(run.agents, run.models) || 'claude');
    const dir = this.visualDir(run, attempt.attempt);
    fs.mkdirSync(dir, { recursive: true });
    const { port, url, command } = await expandPorts(run.appUrl!, run.runCommand!);
    const serverGroup = `${run.id}:server`;
    let cast: Screencast | null = null;
    /** Хвост вывода команды запуска — показать человеку, если проверить не удалось (упал API и т. п.). */
    let serverOut = '';

    this.log(run, c.sky(`$ ${command}`) + c.dim(`  # приложение на ${url}`) + '\n');
    let exited: number | null | undefined;
    const server = runProc(command, [], {
      cwd: run.worktreePath,
      env: { ...this.opts.env, PORT: String(port), BROWSER: 'none', CI: '1' },
      shell: true,
      group: serverGroup,
      onStdout: (t) => { serverOut = (serverOut + t).slice(-6000); this.log(run, c.dim(crlf(t)), false); },
      onStderr: (t) => { serverOut = (serverOut + t).slice(-6000); this.log(run, c.dim(crlf(t)), false); },
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

      // Свой Chrome с портом отладки: агент подключается к нему через pw, а окно получает живую трансляцию экрана.
      const live = await this.startLiveBrowser(run, dir, url, serverGroup, session);
      cast = live?.cast ?? null;
      const docs = await this.getChangeDocs(run.id);
      const tg = await this.tools(['git']);
      const changed = await new Git(tg.git, this.opts.env).changedFiles(run.worktreePath, run.baseCommit);
      const prompt = this.prompts.render('visual.md', {
        url,
        dir,
        task: this.taskText(run),
        attachments: this.attachmentsBlock(run),
        proposal: docs.proposal || '(нет плана — быстрая правка, ориентируйся на задачу)',
        specs: docs.specs.map((x) => x.content).join('\n\n') || '(нет)',
        files: changed.filter((f) => !f.startsWith('openspec/')).map((f) => `- ${f}`).join('\n') || '(нет)',
        // Свежая инструкция из команд проекта важнее снимка в run.json: её могли дописать после неудачной проверки.
        notes: this.getProjectConfig(run.projectPath)?.visualNotes || run.visualNotes || '(нет — если нужен вход или данные, которых нет, верни "unverified")',
      });
      const res = await runClaude({
        ...this.agentBase(run, tools.claude),
        env: prependPath(this.opts.env, dir),
        prompt,
        systemPrompt: this.prompts.raw('visual.system.md') + this.modeRules('visual', run)
          + (live ? `\n\nБраузер уже открыт на ${url} и подключён к pw — не вызывай \`pw open\`, переходи командой \`pw goto <url>\`. Человек смотрит на этот экран вживую.` : ''),
        // Визуальная проверка всегда на claude (браузер через pw); модель исполнителя — только если он тоже claude.
        model: run.models.visual || this.claudeModel(run.agents, run.models),
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
      const unverified = parseUnverified(res.text);
      const fmt = (i: ReviewItem) => `${i.file ? `${i.file}${i.line ? ':' + i.line : ''} — ` : ''}${i.message}`;
      if (unverified) {
        // Окружение не дало проверить (не поднялся API, нет входа): исполнитель тут не поможет — идём дальше, решает человек.
        const result: VisualResult = { at: new Date().toISOString(), url, blocking: [], notes: [...parsed.blocking, ...parsed.notes], shots, unverified, command, serverOutput: serverOut.trim() || undefined };
        run.visuals = [...(run.visuals ?? []), result];
        this.log(run, c.amber(`! визуально проверить не удалось: ${unverified}`) + '\n' + c.dim('Задача не возвращается исполнителю — проверьте сами во вкладке «Браузер». Тестовый вход и подготовку данных можно описать в «Инструкции для проверки» в командах проекта.') + '\n');
        this.end(run, attempt, 'done', `Не удалось проверить: ${unverified}`);
        run.next = 'gate2';
        this.save(run);
        return;
      }
      const result: VisualResult = { at: new Date().toISOString(), url, blocking: parsed.blocking, notes: parsed.notes, shots, command, serverOutput: serverOut.trim() || undefined };
      run.visuals = [...(run.visuals ?? []), result];
      if (result.blocking.length) this.log(run, c.coral(`✗ визуальные проблемы (${result.blocking.length}):\n`) + result.blocking.map((i) => `  • ${fmt(i)}`).join('\n') + '\n');
      this.log(run, c.dim(`скриншотов: ${shots.length}`) + '\n');
      this.end(run, attempt, result.blocking.length ? 'failed' : 'done',
        result.blocking.length ? `Проблем: ${result.blocking.length}, скриншотов: ${shots.length}` : `Выглядит верно, скриншотов: ${shots.length}`);

      if (!result.blocking.length) {
        run.next = 'gate2';
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
      cast?.stop();
      this.emit({ type: 'visual.frame', runId: run.id, frame: null });
      await runProc('npx', ['-y', '@playwright/cli@latest', `-s=psflow-${run.id.slice(0, 8)}`, 'close'], { cwd: dir, env: this.opts.env, timeoutMs: 20_000 }).catch(() => undefined);
      await killGroup(serverGroup);
      // Профиль Chrome (десятки МБ) после проверки не нужен — скриншоты остаются.
      fs.rmSync(path.join(dir, 'chrome-profile'), { recursive: true, force: true });
    }
  }

  /**
   * Chrome без окна с портом отладки в группе процессов сервера (гаснет вместе с ним), pw подключается к нему.
   * null — Chrome не найден или не поднялся: агент откроет свой браузер через `pw open`, без трансляции.
   */
  private async startLiveBrowser(run: RunFile, dir: string, url: string, group: string, session: string): Promise<{ cast: Screencast } | null> {
    const chrome = findChrome(this.opts.env);
    if (!chrome) return null;
    const port = await freePort();
    void runProc(chrome, [
      '--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${path.join(dir, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check',
      // Плотность как у Retina: в трансляции и на скриншотах текст чёткий, а не растянутый вдвое.
      '--window-size=1440,900', '--force-device-scale-factor=2', url,
    ], { cwd: dir, env: this.opts.env, group }).catch(() => undefined);
    if (!(await waitForCdp(port))) {
      this.log(run, c.dim('Chrome для трансляции не поднялся — агент откроет свой браузер.') + '\n');
      return null;
    }
    const att = await runProc('npx', ['-y', '@playwright/cli@latest', `-s=${session}`, 'attach', `--cdp=http://127.0.0.1:${port}`], { cwd: dir, env: this.opts.env, timeoutMs: 120_000 });
    if (att.code !== 0) {
      this.log(run, c.dim('pw не подключился к Chrome — агент откроет свой браузер.') + '\n');
      return null;
    }
    const cast = new Screencast(port, (frame) => this.emit({ type: 'visual.frame', runId: run.id, frame }));
    cast.start();
    this.log(run, c.dim('Браузер агента транслируется во вкладку «Браузер».') + '\n');
    return { cast };
  }

  /** Скриншот визуальной проверки для окна: data URL (только из каталога прогона). */
  getVisualShot(id: string, file: string): string | null {
    if (!fs.existsSync(file)) return null;
    // Сравниваем реальные пути: каталог данных может быть ссылкой.
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const root = real(path.join(this.opts.dataDir, 'visual', id));
    const full = real(file);
    if (!full.startsWith(root + path.sep)) return null;
    const ext = path.extname(full).slice(1).toLowerCase();
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext || 'png'};base64,${fs.readFileSync(full).toString('base64')}`;
  }

  private async stageReview(run: RunFile) {
    const tools = await this.tools(['git']);
    const attempt = this.begin(run, 'review', run.models.reviewer);
    const git = new Git(tools.git, this.opts.env);
    let diff = await git.diffText(run.worktreePath, run.baseCommit, [RUN_JSON_GLOB, ...this.envFilesOf(run)]);
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

    const res = await this.runRole(run, 'reviewer', {
      prompt,
      readOnly: true,
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
      // Порядок: ревью диффа (дёшево, без окружения) → визуальная проверка → приёмка со свежими скриншотами.
      run.next = run.visual ? 'visual' : 'gate2';
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
      const exclude = [
        ...(modeOf(run) === 'quick' && RunStore.inProject(run) ? [path.relative(run.worktreePath, RunStore.runJsonPath(run)).split(path.sep).join('/')] : []),
        // Скопированные файлы окружения — секреты разработчика, в коммит не попадают даже без .gitignore.
        ...this.envFilesOf(run),
      ];
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
    this.log(run, sha === run.baseCommit
      ? c.amber(`! изменений нет — коммит в ${run.branch} не создан`) + '\n'
      : c.mint(`✓ коммит ${sha.slice(0, 8)} в ветке ${run.branch}. Слияние — за вами.`) + '\n');
    if (run.workspace === 'branch') {
      this.log(run, c.dim(`Проект остался на ветке ${run.branch} — можно посмотреть результат.${run.originalBranch ? ` Вернуться: git checkout ${run.originalBranch}` : ''}`) + '\n');
    }
    this.emit({ type: 'run.updated', run });
    this.emit({ type: 'run.finished', runId: run.id, status: 'finished' });
    // Уроки для следующих прогонов — в фоне, коммит уже сделан.
    void this.learn(run).catch(() => undefined);
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
    if (run.next === 'gate0') return `У планировщика ${run.clarify?.questions.length ?? 0} ${(run.clarify?.questions.length ?? 0) === 1 ? 'вопрос' : 'вопроса'} по задаче — ответьте, чтобы план не строился на догадках.`;
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

  /** Модель для служебных запусков claude: модель исполнителя или планировщика, если эту роль выполняет claude. */
  private claudeModel(agents: Partial<Record<Role, AgentKind>> | undefined, models: Record<Role, string>): string {
    const a = { ...DEFAULT_AGENTS, ...agents };
    if (a.executor === 'claude') return models.executor;
    if (a.planner === 'claude') return models.planner;
    return '';
  }

  /**
   * Запуск агента роли: claude или codex — как выбрано в настройках на момент старта прогона.
   * readOnly — только чтение (ревью); иначе агент правит файлы в рабочей копии прогона.
   */
  private async runRole(run: RunFile, role: Role, o: {
    prompt: string; systemPrompt?: string; openspec?: boolean; readOnly?: boolean; images?: string[]; outputSchema?: object;
    sessionId?: string; resume?: string;
  }): Promise<AgentResult> {
    const agent = run.agents?.[role] ?? DEFAULT_AGENTS[role];
    const tools = await this.tools(o.openspec ? [agent, 'openspec'] : [agent]);
    const base = this.agentBase(run, tools[agent], o.openspec ? tools.openspec : undefined);
    const model = run.models[role] || undefined;
    // Знания о проекте (профиль и уроки) — всем ролям; в продолжении сессии они уже в контексте.
    const systemPrompt = o.resume ? o.systemPrompt : `${o.systemPrompt ?? ''}${this.knowledgeBlock(run)}` || undefined;
    if (agent === 'codex') {
      return runCodex({ ...base, prompt: o.prompt, systemPrompt, model, sandbox: o.readOnly ? 'read-only' : 'workspace-write', images: o.images, outputSchema: o.outputSchema });
    }
    // claude не принимает изображения флагом — даём пути, он откроет их инструментом Read.
    const images = o.images?.filter((f) => fs.existsSync(f)) ?? [];
    const prompt = images.length ? `${o.prompt}\n\nИзображения (открой инструментом Read):\n${images.map((f) => `- ${f}`).join('\n')}` : o.prompt;
    const dirs = [...new Set([...(base.addDirs ?? []), ...images.map((f) => path.dirname(f))])];
    return runClaude({
      ...base,
      prompt,
      systemPrompt,
      model,
      addDirs: dirs.length ? dirs : undefined,
      tools: o.readOnly ? ['Read', 'Glob', 'Grep'] : undefined,
      sessionId: o.sessionId,
      resume: o.resume,
    });
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
  return s === 'gate0' || s === 'gate1' || s === 'gate2' || s === 'limit';
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
/**
 * Число ошибок в выводе линтера или тестов — по итоговым строкам ESLint, tsc, Jest/Vitest, node:test, pytest, mocha, go.
 * null — если вывод не распознан.
 */
export function errorCount(output: string): number | null {
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = [
    /✖\s*\d+\s+problems?\s*\((\d+)\s+errors?/g, // ESLint
    /Found (\d+) errors?/g, // tsc
    /Tests?:\s+(\d+) failed/g, // Jest, Vitest
    /^[ℹ#]\s*fail (\d+)/gm, // node:test, TAP
    /(\d+) failed(?:,| in )/g, // pytest
    /(\d+) failing/g, // mocha
  ];
  for (const re of patterns) {
    const found = [...text.matchAll(re)];
    if (found.length) return found.reduce((n, m) => n + Number(m[1]), 0);
  }
  const goFails = text.match(/^--- FAIL/gm);
  if (goFails) return goFails.length;
  const lines = text.split('\n').filter((l) => /\berror\b/i.test(l)).length;
  return lines || null;
}

/**
 * Подставить свободные порты: {port} — порт приложения, {port:имя} — дополнительные (API, воркер…),
 * у каждого прогона свои — параллельные прогоны не делят один порт и не ходят в чужой API.
 */
async function expandPorts(url: string, command: string): Promise<{ port: number; url: string; command: string }> {
  const used = new Set<number>();
  const take = async () => {
    for (let i = 0; i < 20; i++) {
      const p = await freePort();
      if (!used.has(p)) return used.add(p), p;
    }
    throw new Error('Не нашлось свободных портов');
  };
  const port = await take();
  const named = new Map<string, number>();
  for (const m of `${url} ${command}`.matchAll(/\{port:([a-z0-9_-]+)\}/gi)) {
    if (!named.has(m[1])) named.set(m[1], await take());
  }
  const fill = (t: string) => t.replace(/\{port:([a-z0-9_-]+)\}/gi, (_, n: string) => String(named.get(n))).replaceAll('{port}', String(port));
  return { port, url: fill(url), command: fill(command) };
}

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
/** Визуальная проверка: причина, по которой проверить не удалось (поле "unverified"), иначе null. */
export function parseUnverified(text: string): string | null {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1)) as { unverified?: unknown };
    return typeof j.unverified === 'string' && j.unverified.trim() ? j.unverified.trim().slice(0, 400) : null;
  } catch {
    return null;
  }
}

/** Вопросы уточнения из ответа планировщика (не больше 4). */
export function parseQuestions(text: string): ClarifyQuestion[] {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return [];
  try {
    const j = JSON.parse(text.slice(a, b + 1)) as { questions?: unknown };
    if (!Array.isArray(j.questions)) return [];
    return j.questions
      .filter((q): q is { q: string; options?: unknown; why?: unknown } => Boolean(q) && typeof (q as { q?: unknown }).q === 'string' && (q as { q: string }).q.trim().length > 3)
      .slice(0, 4)
      .map((q) => ({
        q: q.q.trim(),
        options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string' && Boolean(o.trim())).slice(0, 4) : undefined,
        why: typeof q.why === 'string' && q.why.trim() ? q.why.trim() : undefined,
      }));
  } catch {
    return [];
  }
}

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
