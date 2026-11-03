// Ручная проверка: приложение из ветки прогона на свободном порту.
import fs from 'node:fs';
import type { Kernel } from '../kernel.js';
import { expandPorts, portEnv, waitForUrl } from '../net.js';
import { killGroup, run as runProc } from '../proc.js';
import type { PreviewState } from '../types.js';
import { startChatPreview } from './chat.js';
import { getProjectConfig } from './projects.js';
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
  const cur = k.previews.get(id);
  if (cur && (cur.status === 'starting' || cur.status === 'ready')) return cur;
  const cfg = getProjectConfig(k, r.projectPath);
  const runCommand = cfg?.runCommand || r.runCommand;
  const appUrl = cfg?.appUrl || r.appUrl;
  if (!runCommand || !appUrl) throw new Error('Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты»).');
  if (!fs.existsSync(r.worktreePath)) throw new Error(`Рабочая копия прогона не найдена: ${r.worktreePath}`);
  if (r.workspace === 'branch') await ensureOnBranch(k, r);
  copyEnvFiles(k, r);
  return launchPreview(k, id, { repo: r.projectPath, cwd: r.worktreePath, runCommand, appUrl });
}

/** Запуск приложения для ручной проверки: подготовка, сервер на свободном порту, ожидание адреса. */
export async function launchPreview(
  k: Kernel,
  id: string,
  o: { repo: string; cwd: string; runCommand: string; appUrl: string },
): Promise<PreviewState> {
  const { repo, cwd, runCommand, appUrl } = o;
  const { port, url, command } = await expandPorts(appUrl, runCommand);
  const group = `${id}:preview`;
  let output = '';
  let exited: number | null | undefined;
  const tail = (t: string) => {
    output = (output + t).slice(-4000);
  };
  setPreview(k, id, { status: 'starting', url, command });
  try {
    await prepareApp(k, { repo, cwd, group, onOutput: tail });
  } catch (e) {
    const state: PreviewState = { status: 'failed', url, command, output, error: (e as Error).message.split('\n')[0] };
    setPreview(k, id, state);
    return state;
  }
  // Остановили, пока шла подготовка.
  if (k.previews.get(id)?.url !== url || k.previews.get(id)?.status !== 'starting') return getPreview(k, id);
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
    // Сервер упал сам (не по «Остановить») — показываем вывод.
    if (now && now.url === url && (now.status === 'ready' || now.status === 'starting')) {
      setPreview(k, id, { status: 'failed', url, command, error: `Приложение завершилось с кодом ${res.code}`, output });
    }
  });
  const ready = await waitForUrl(url, 120_000, () => exited !== undefined || k.previews.get(id)?.url !== url);
  const now = k.previews.get(id);
  if (!now || now.url !== url) return getPreview(k, id); // остановили, пока поднималось
  if (!ready) {
    await killGroup(group);
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
  const state: PreviewState = { status: 'ready', url, command };
  setPreview(k, id, state);
  return state;
}

export async function stopPreview(k: Kernel, id: string): Promise<void> {
  if (!k.previews.has(id)) return;
  setPreview(k, id, { status: 'idle' });
  await killGroup(`${id}:preview`);
}
