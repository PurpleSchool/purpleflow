// Ядро прогона: общее состояние и инфраструктура, на которую опираются стадии и сервисы —
// события, run.json, лог, попытки стадий, поиск инструментов и запуск агентов.
// Доменной логики здесь нет: она в engine.ts, stages/ и services/.
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { runClaude } from './agents/claude.js';
import { runCodex } from './agents/codex.js';
import { type AgentResult, addUsage, c, crlf, emptyUsage } from './agents/common.js';
import { detectTools } from './env.js';
import { run as runProc, setPidTracker } from './proc.js';
import { Prompts } from './prompts.js';
import { type BasePrep, type CoreOptions, type Listener, StopSignal, type Tools } from './runtime.js';
import { STAGE_TITLES, isGate } from './stage-info.js';
import { RunStore } from './store.js';
import { setTraceFile } from './trace.js';
import type { CoreEvent, PreviewState, RunFile, StageAttempt, StageId } from './types.js';

/** Операции движка, которые нужны стадиям и сервисам; связываются в Orchestrator, чтобы модули не зависели от движка. */
export interface EngineHooks {
  drive(run: RunFile): Promise<void>;
  halt(id: string): Promise<void>;
}

export class Kernel {
  readonly store: RunStore;
  readonly prompts: Prompts;
  readonly listeners = new Set<Listener>();
  /** Прогоны, по которым сейчас крутится цикл стадий. */
  readonly driving = new Set<string>();
  readonly stopping = new Set<string>();
  /** Подготовка и исходные проверки, идущие в фоне параллельно с уточнением. */
  readonly basePrep = new Map<string, BasePrep>();
  /** Вывод фоновой работы копится здесь и попадает в лог одним куском, а не вперемешку с агентом. */
  readonly logHold = new AsyncLocalStorage<string[]>();
  /** Запущенные приложения ручной проверки по прогонам и чатам. */
  readonly previews = new Map<string, PreviewState>();
  /** Прогоны, по которым менеджер сейчас готовит ответ. */
  readonly managerBusy = new Set<string>();
  /** Чаты, в которых агент сейчас отвечает. */
  readonly chatBusy = new Set<string>();
  /** Проекты, для которых сейчас идёт проверка окружения. */
  readonly envChecks = new Set<string>();
  /** Очередь прогонов сейчас разбирается. */
  pumping = false;
  engine!: EngineHooks;

  constructor(readonly opts: CoreOptions) {
    this.store = new RunStore(opts.dataDir);
    setTraceFile(path.join(opts.dataDir, 'core.log'));
    this.prompts = new Prompts(opts.promptsDir);
    const store = this.store;
    setPidTracker({
      add: (g, pid) => store.writePids(g, [...store.readPids(g).filter((p) => p !== pid), pid]),
      remove: (g, pid) =>
        store.writePids(
          g,
          store.readPids(g).filter((p) => p !== pid),
        ),
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
      } catch {
        /* слушатель UI не должен ронять ядро */
      }
    }
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

  log(run: RunFile, text: string, convert = true) {
    const t = convert ? crlf(text) : text;
    const hold = this.logHold.getStore();
    if (hold) {
      hold.push(t);
      return;
    }
    this.store.appendLog(run.id, t);
    this.emit({ type: 'agent.output', runId: run.id, stage: run.next, text: t });
  }

  /** Предупреждение: прогон идёт дальше, но человеку стоит знать — в логе и в окне прогона. */
  warn(run: RunFile, text: string) {
    this.log(run, c.amber(`! ${text}`) + '\n');
    run.warnings = [...(run.warnings ?? []), { at: new Date().toISOString(), text }].slice(-10);
    this.save(run);
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
    for (const a of run.attempts)
      if (a.status === 'running' && !isGate(a.stage)) Object.assign(a, { status: 'stopped', endedAt: new Date().toISOString() });
    run.status = 'stopped';
    run.message = message;
    this.save(run);
    this.log(run, c.amber(`■ ${message}`) + '\n');
    this.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message });
  }

  fail(run: RunFile, error: string) {
    const stage = run.next;
    for (const a of run.attempts)
      if (a.status === 'running') Object.assign(a, { status: 'failed', endedAt: new Date().toISOString(), error });
    run.status = 'stopped';
    run.message = error;
    this.save(run);
    this.log(run, c.coral(`✗ ${error}`) + '\n');
    this.emit({ type: 'stage.failed', runId: run.id, stage, error });
    this.emit({ type: 'run.finished', runId: run.id, status: 'stopped', message: error });
  }

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

  async tools(need: (keyof Tools)[]): Promise<Tools> {
    const manual = this.opts.getSettings().toolPaths;
    const found = await detectTools(this.opts.env, manual);
    const missing = need.filter((n) => !found[n].path || found[n].error);
    if (missing.length) {
      throw new Error(`Не найдены: ${missing.join(', ')}. Укажите пути в настройках.`);
    }
    return { git: found.git.path!, claude: found.claude.path!, codex: found.codex.path!, openspec: found.openspec.path! };
  }

  async hasTool(name: keyof Tools): Promise<boolean> {
    const t = (await detectTools(this.opts.env, this.opts.getSettings().toolPaths))[name];
    return Boolean(t.path && !t.error);
  }

  /** Запуск агентов — через них, чтобы тесты конвейера могли подменить claude и codex. */
  claude(o: Parameters<typeof runClaude>[0]) {
    return (this.opts.runners?.claude ?? runClaude)(o);
  }

  codex(o: Parameters<typeof runCodex>[0]) {
    return (this.opts.runners?.codex ?? runCodex)(o);
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
}
