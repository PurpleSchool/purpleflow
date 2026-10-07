// Ядро оркестратора в отдельном utilityProcess: окно не подвисает ни от агентов, ни от git.
import path from 'node:path';
import {
  Git, Orchestrator, detectProjectCommands, killAll, loadLoginShellEnv, which, type CoreSettings,
} from '@psflow/core';
import type { CoreApi, HostMessage, HostRequest } from '../shared/ipc';

const port = process.parentPort;
let settings: CoreSettings;
let core: Orchestrator | null = null;
let env: NodeJS.ProcessEnv = process.env;

const send = (m: HostMessage) => port.postMessage(m);

function api(c: Orchestrator): CoreApi {
  return {
    dispatch: (cmd) => c.dispatch(cmd),
    listRuns: async () => c.listRuns(),
    getRun: async (id) => c.getRun(id),
    getLog: async (id) => c.getLog(id),
    getDiff: (id) => c.getDiff(id),
    getChangeDocs: async (id) => c.getChangeDocs(id),
    detectTools: () => c.detectTools(),
    testConnection: () => c.testConnection(),
    isDriving: async (id) => c.isDriving(id),
    listBranches: (id) => c.listBranches(id),
    getAttachment: async (id, i) => c.getAttachment(id, i),
    detectCommandsAI: (dir) => c.detectCommandsAI(dir),
    getProjectConfig: async (dir) => c.getProjectConfig(dir),
    suggestMode: (task) => c.suggestMode(task),
    getVisualShot: async (id, file) => c.getVisualShot(id, file),
    saveProjectConfig: async (dir, cfg) => c.saveProjectConfig(dir, cfg),
    detectProject: async (dir) => {
      const gitBin = settings.toolPaths.git || which('git', env) || 'git';
      const isRepo = await new Git(gitBin, env).isRepo(dir).catch(() => false);
      return { ...detectProjectCommands(dir), isRepo, name: path.basename(dir) };
    },
  };
}

let methods: CoreApi | null = null;

port.on('message', async (e: { data: HostRequest }) => {
  const msg = e.data;
  if (msg.kind === 'init') {
    settings = msg.settings as CoreSettings;
    env = loadLoginShellEnv(process.env);
    core = new Orchestrator({ dataDir: msg.dataDir, promptsDir: msg.promptsDir, env, getSettings: () => settings });
    await core.recover();
    core.on((event) => send({ kind: 'event', event }));
    methods = api(core);
    send({ kind: 'ready' });
    return;
  }
  if (msg.kind === 'settings') {
    settings = msg.settings as CoreSettings;
    return;
  }
  if (msg.kind === 'shutdown') {
    await killAll();
    send({ kind: 'reply', id: msg.id, ok: true, result: null });
    return;
  }
  if (msg.kind === 'call') {
    try {
      if (!methods) throw new Error('Ядро ещё не запущено');
      const fn = methods[msg.method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof fn !== 'function') throw new Error('Эта функция появилась в новой версии — перезапустите приложение.');
      const result = await fn(...msg.args);
      send({ kind: 'reply', id: msg.id, ok: true, result });
    } catch (err) {
      send({ kind: 'reply', id: msg.id, ok: false, error: (err as Error).message ?? String(err) });
    }
  }
});

process.on('uncaughtException', (err) => {
  // Ядро не должно падать от одной ошибки в стадии.
  console.error('[core-host] uncaught', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[core-host] unhandled', err);
});
