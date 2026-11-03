import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import { trace } from './trace.js';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Текст в stdin; без него stdin закрывается сразу. */
  input?: string;
  /** Запуск строки через системный шелл (команда тестов). */
  shell?: boolean;
  timeoutMs?: number;
  /** Остановить, если процесс столько молчит (ни stdout, ни stderr) — признак зависания. */
  idleTimeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /** Группа для массовой остановки (обычно id прогона). */
  group?: string;
  /** Сервер: шелл мог выйти, оставив приложение в фоне, — пока оно держит вывод, процесс считается живым. */
  waitForOutput?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Остановлен по idleTimeoutMs — молчал слишком долго. */
  idle?: boolean;
  killed: boolean;
  durationMs: number;
  spawnError?: string;
}

const MAX_BUFFER = 4 * 1024 * 1024;
/** Процесс вышел, а его фоновый потомок держит stdout: столько ждём вывод, потом перестаём. */
const OUTPUT_GRACE_MS = 3000;

export interface PidTracker {
  add(group: string, pid: number): void;
  remove(group: string, pid: number): void;
}
let tracker: PidTracker | null = null;
/** PID-ы процессов прогона сохраняются на диск: после аварийного выхода их можно добить при восстановлении. */
export function setPidTracker(t: PidTracker | null) {
  tracker = t;
}

/** Вывод ps -o etime= ([[дд-]чч:]мм:сс) в секунды; null — не разобрали. */
export function parseEtime(s: string): number | null {
  const m = s.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : null;
}

/** Процесс начался уже после того, как PID был записан: номер достался кому-то другому. */
async function startedAfter(pid: number, recordedAt: number): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const r = await run('ps', ['-o', 'etime=', '-p', String(pid)], { cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
  const age = parseEtime(r.stdout);
  // Запас в пару секунд: и секунды ps, и время файла округлены.
  return age != null && Date.now() - age * 1000 > recordedAt + 2000;
}

/**
 * Убить дерево по PID из прошлого запуска приложения (если процесс ещё жив).
 * recordedAt — когда PID записан: за время простоя и после перезагрузки номер мог перейти к чужому процессу.
 */
export async function killPid(pid: number, recordedAt?: number): Promise<void> {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  if (recordedAt != null && (await startedAfter(pid, recordedAt))) return;
  await new Promise<void>((resolve) => treeKill(pid, 'SIGKILL', () => resolve()));
}

/** Все живые дочерние процессы по группам — чтобы «Стоп» убивал деревья целиком. */
const live = new Map<string, Set<ChildProcess>>();
const killedByUs = new WeakSet<ChildProcess>();

function closeOutput(child: ChildProcess) {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid == null) return resolve();
    killedByUs.add(child);
    // Сам процесс уже вышел, вывод держит его фоновый потомок: без этого close не наступит, а «Стоп» и таймаут ничего не сделают.
    if (child.exitCode !== null || child.signalCode !== null) {
      closeOutput(child);
      return resolve();
    }
    treeKill(child.pid, 'SIGTERM', () => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      // Если за 3 секунды не умер — добиваем.
      const t = setTimeout(() => {
        if (child.exitCode === null && child.pid != null) treeKill(child.pid, 'SIGKILL', () => resolve());
        else resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  });
}

export async function killGroup(group: string): Promise<void> {
  const set = live.get(group);
  if (!set) return;
  await Promise.all([...set].map(killTree));
  // Пока ждали, в группе мог появиться новый процесс — он должен оставаться видимым для следующего «Стоп».
  if (!set.size) live.delete(group);
}

export async function killAll(): Promise<void> {
  await Promise.all([...live.keys()].map(killGroup));
}

function append(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
}

export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = opts.shell
        ? spawn(cmd, { cwd: opts.cwd, env: opts.env, shell: true, windowsHide: true })
        : spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    } catch (e) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        killed: false,
        durationMs: 0,
        spawnError: (e as Error).message,
      });
      return;
    }

    const group = opts.group ?? '_default';
    if (!live.has(group)) live.set(group, new Set());
    live.get(group)!.add(child);
    const pid = child.pid;
    // Учёт PID — страховка; сбой записи не должен оставить запущенный процесс без присмотра.
    const track = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        trace('proc: учёт PID', e);
      }
    };
    if (pid != null) track(() => tracker?.add(group, pid));

    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let idle = false;
    let spawnError: string | undefined;
    let idleTimer: NodeJS.Timeout | null = null;
    const touch = () => {
      if (!opts.idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        idle = true;
        void killTree(child);
      }, opts.idleTimeoutMs);
    };
    touch();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
      touch();
      opts.onStdout?.(chunk);
      if (opts.onStdoutLine) {
        pending += chunk;
        let idx: number;
        while ((idx = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, idx).replace(/\r$/, '');
          pending = pending.slice(idx + 1);
          if (line) opts.onStdoutLine(line);
        }
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
      touch();
      opts.onStderr?.(chunk);
    });

    child.stdin?.on('error', () => {
      /* процесс мог закрыть stdin раньше */
    });
    if (opts.input != null) child.stdin?.end(opts.input);
    else child.stdin?.end();

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void killTree(child);
        }, opts.timeoutMs)
      : null;

    child.on('error', (err) => {
      spawnError = err.message;
    });

    let graceTimer: NodeJS.Timeout | null = null;
    child.on('exit', () => {
      if (!opts.waitForOutput) graceTimer = setTimeout(() => closeOutput(child), OUTPUT_GRACE_MS);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
      const set = live.get(group);
      set?.delete(child);
      if (set && !set.size) live.delete(group);
      if (pid != null) track(() => tracker?.remove(group, pid));
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        idle: idle || undefined,
        killed: killedByUs.has(child) && !timedOut,
        durationMs: Date.now() - started,
        spawnError,
      });
    });
  });
}

/** Короткая команда без потокового вывода; бросает ошибку при ненулевом коде. */
export async function exec(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<string> {
  const r = await run(cmd, args, { cwd, env, timeoutMs });
  if (r.spawnError) throw new Error(`${cmd}: ${r.spawnError}`);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} → код ${r.code}${r.timedOut ? ' (таймаут)' : ''}\n${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

export function liveCount(group?: string): number {
  if (group) return live.get(group)?.size ?? 0;
  let n = 0;
  for (const s of live.values()) n += s.size;
  return n;
}
