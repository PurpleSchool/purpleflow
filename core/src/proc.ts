import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
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
const STOP_GRACE_MS = 3000;

// Надзиратель остаётся в группе после выхода шелла сервера. Через отдельный канал он сигналит
// своей группе, поэтому остановка не зависит от PID вышедшего шелла. EOF также гасит группу
// при аварийном закрытии PurpleFlow. Сам сервер не наследует канал и видит обычные stdin/out/err.
const SERVER_WRAPPER = `
(
  trap '' TERM
  while IFS= read -r signal; do
    if [ "$signal" = TERM ]; then kill -s TERM 0; fi
  done
  kill -s KILL 0
) <&3 3<&- >/dev/null 2>&1 &
exec 3<&-
exec /bin/sh -c "$1"
`;

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
const serverControls = new WeakMap<ChildProcess, Writable>();

function closeOutput(child: ChildProcess) {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (pid == null) return resolve();
    killedByUs.add(child);
    const control = serverControls.get(child);
    if (control) {
      // Шелл мог выйти, но группа ещё существует. Ждём закрытия потоков, а не выхода шелла.
      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.off('close', onClose);
        if (!control.writableEnded) control.end();
        closeOutput(child);
        resolve();
      }, STOP_GRACE_MS);
      child.once('close', onClose);
      if (!control.writableEnded) control.write('TERM\n');
      return;
    }
    // Вне отдельной группы можно закончить ожидание вывода, даже если потомок держит потоки.
    if (child.exitCode !== null || child.signalCode !== null) {
      closeOutput(child);
      return resolve();
    }
    treeKill(pid, 'SIGTERM', () => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      // Если за 3 секунды не умер — добиваем.
      const t = setTimeout(() => {
        if (child.exitCode === null) treeKill(pid, 'SIGKILL', () => resolve());
        else resolve();
      }, STOP_GRACE_MS);
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
    const superviseServer = process.platform !== 'win32' && opts.shell && opts.waitForOutput;
    const spawnOptions = { cwd: opts.cwd, env: opts.env, windowsHide: true };
    try {
      if (superviseServer) {
        child = spawn('/bin/sh', ['-c', SERVER_WRAPPER, 'purpleflow-server', cmd], {
          ...spawnOptions,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        });
      } else {
        child = opts.shell ? spawn(cmd, { ...spawnOptions, shell: true }) : spawn(cmd, args, spawnOptions);
      }
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
    const control = superviseServer ? (child.stdio[3] as Writable | null) : null;
    if (control) {
      serverControls.set(child, control);
      control.on('error', (e) => trace('proc: канал остановки сервера', e));
      const release = () => {
        // При перенаправленном выводе потомки могут остаться и после закрытия обоих потоков.
        // Закрываем канал только после выхода команды, чтобы не гасить ещё работающий сервер.
        if (
          (child.exitCode !== null || child.signalCode !== null) &&
          child.stdout?.destroyed &&
          child.stderr?.destroyed &&
          !control.writableEnded
        )
          control.end();
      };
      child.once('exit', release);
      child.stdout?.once('close', release);
      child.stderr?.once('close', release);
    }
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
