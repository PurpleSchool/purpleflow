// Ручная проверка: приложение из ветки прогона на свободном порту.
import fs from 'node:fs';
import type { Kernel } from '../kernel.js';
import { expandPorts, portEnv, waitForUrl } from '../net.js';
import { killGroup, run as runProc } from '../proc.js';
import type { PreviewState, RunFile } from '../types.js';
import { startChatPreview } from './chat.js';
import { getProjectConfig } from './projects.js';
import { workDir } from './repos.js';
import { copyEnvFiles, ensureOnBranch, prepareApp } from './workspace.js';

export function getPreview(k: Kernel, id: string): PreviewState {
  return k.previews.get(id) ?? { status: 'idle' };
}

export function setPreview(k: Kernel, id: string, state: PreviewState) {
  if (state.status === 'idle') k.previews.delete(id);
  else k.previews.set(id, state);
  k.emit({ type: 'preview.state', runId: id, state });
}

/** Поднять приложение в рабочей копии прогона на свободном порту (команды «Запуск приложения» и «Адрес»). */
export async function startPreview(k: Kernel, id: string): Promise<PreviewState> {
  // Чат — приложение из папки проекта чата.
  if (id.startsWith('chat-')) return startChatPreview(k, id);
  const r = k.mustLoad(id);
  return launchPreview(k, id, () => {
    const cfg = getProjectConfig(k, r.projectPath);
    const runCommand = cfg?.runCommand || r.runCommand;
    const appUrl = cfg?.appUrl || r.appUrl;
    if (!runCommand || !appUrl) throw new Error('Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты»).');
    if (!fs.existsSync(r.worktreePath)) throw new Error(`Рабочая копия прогона не найдена: ${r.worktreePath}`);
    return { repo: r.projectPath, cwd: workDir(r), runCommand, appUrl, run: r };
  });
}

/** Сколько вывода сервера держим и как часто отправляем его в окно. */
const OUTPUT_MAX = 20_000;
const OUTPUT_MS = 400;

interface PreviewOptions {
  repo: string;
  cwd: string;
  runCommand: string;
  appUrl: string;
  run?: RunFile;
}

/** Запуск резервируется до первого await. Повторный запрос ждёт тот же результат. */
export function launchPreview(k: Kernel, id: string, options: () => PreviewOptions): Promise<PreviewState> {
  const state = getPreview(k, id);
  if (state.status === 'ready') return Promise.resolve(state);
  const existing = k.previewLaunches.get(id);
  if (existing) return existing;
  const isCurrent = (): boolean => k.previewLaunches.get(id) === launch;
  const launch = Promise.resolve()
    .then(() => (isCurrent() ? runPreview(k, id, options(), isCurrent) : getPreview(k, id)))
    .then(
      (result) => {
        if (isCurrent() && result.status !== 'ready') k.previewLaunches.delete(id);
        return result;
      },
      (error: unknown) => {
        if (!isCurrent()) return getPreview(k, id);
        k.previewLaunches.delete(id);
        throw error;
      },
    );
  k.previewLaunches.set(id, launch);
  return launch;
}

async function runPreview(k: Kernel, id: string, o: PreviewOptions, isCurrent: () => boolean): Promise<PreviewState> {
  const { repo, cwd, runCommand, appUrl, run } = o;
  if (run) {
    await ensureOnBranch(k, run);
    if (!isCurrent()) return getPreview(k, id);
    copyEnvFiles(k, run);
  }
  const { port, url, command } = await expandPorts(appUrl, runCommand);
  if (!isCurrent()) return getPreview(k, id);
  const group = `${id}:preview`;
  let output = '';
  let exited: number | null | undefined;
  // Вывод сервера виден, пока он поднимается и работает: в окно — не чаще OUTPUT_MS, чтобы не забить события.
  let pending: NodeJS.Timeout | null = null;
  const publish = () => {
    pending = null;
    const now = k.previews.get(id);
    if (isCurrent() && now && (now.status === 'starting' || now.status === 'ready') && now.output !== output)
      setPreview(k, id, { ...now, output });
  };
  const tail = (t: string) => {
    output = (output + t).slice(-OUTPUT_MAX);
    pending ??= setTimeout(publish, OUTPUT_MS);
  };
  setPreview(k, id, { status: 'starting', url, command });
  try {
    await prepareApp(k, { repo, cwd, group, onOutput: tail });
  } catch (e) {
    if (!isCurrent()) return getPreview(k, id);
    const state: PreviewState = { status: 'failed', url, command, output, error: (e as Error).message.split('\n')[0] };
    setPreview(k, id, state);
    return state;
  }
  // Остановили, пока шла подготовка.
  if (!isCurrent()) return getPreview(k, id);
  const server = runProc(command, [], {
    cwd,
    env: { ...k.opts.env, ...portEnv(runCommand, port), BROWSER: 'none' },
    shell: true,
    group,
    waitForOutput: true,
    onStdout: tail,
    onStderr: tail,
  });
  void server.then((res) => {
    exited = res.code;
    const now = k.previews.get(id);
    // При запуске сбой обработает ожидание URL. После готовности — сообщаем сразу.
    if (isCurrent() && now?.status === 'ready') {
      k.previewLaunches.delete(id);
      setPreview(k, id, { status: 'failed', url, command, error: `Приложение завершилось с кодом ${res.code}`, output });
    }
  });
  const ready = await waitForUrl(url, 120_000, () => exited !== undefined || !isCurrent());
  if (!isCurrent()) return getPreview(k, id);
  if (!ready || exited !== undefined) {
    await killGroup(group);
    if (!isCurrent()) return getPreview(k, id);
    const state: PreviewState = {
      status: 'failed',
      url,
      command,
      output,
      error:
        exited !== undefined
          ? `Приложение завершилось с кодом ${exited}, не открыв ${url}`
          : `За 2 минуты приложение не ответило на ${url}`,
    };
    setPreview(k, id, state);
    return state;
  }
  const state: PreviewState = { status: 'ready', url, command, ...(output && { output }) };
  setPreview(k, id, state);
  return state;
}

export async function stopPreview(k: Kernel, id: string): Promise<void> {
  const hadLaunch = k.previewLaunches.delete(id);
  if (!hadLaunch && !k.previews.has(id)) return;
  const stopped = killGroup(`${id}:preview`);
  setPreview(k, id, { status: 'idle' });
  await stopped;
}
