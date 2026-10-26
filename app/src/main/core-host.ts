// Ядро оркестратора в отдельном utilityProcess: окно не подвисает ни от агентов, ни от git.
import path from 'node:path';
import {
  Git, Orchestrator, checkCommand, detectProjectCommands, findEnvFiles, killAll, loadLoginShellEnv, which, type CoreSettings,
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
    getChangedFiles: (id) => c.getChangedFiles(id),
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
    checkCommands: async (dir, cmds) => Object.fromEntries(Object.entries(cmds).map(([k, v]) => [k, v.trim() ? checkCommand(dir, v) : []])),
    getKnowledge: async (dir) => c.getKnowledge(dir),
    saveKnowledge: async (dir, k) => c.saveKnowledge(dir, k),
    refreshProfile: (dir) => c.refreshProfile(dir),
    prReady: (id) => c.prReady(id),
    getPrStatus: (id) => c.getPrStatus(id),
    getPrDetails: (id) => c.getPrDetails(id),
    getStorage: () => c.getStorage(),
    cleanStorage: (id) => c.cleanStorage(id),
    startPreview: (id) => c.startPreview(id),
    stopPreview: (id) => c.stopPreview(id),
    getPreview: async (id) => c.getPreview(id),
    saveProjectConfig: async (dir, cfg) => c.saveProjectConfig(dir, cfg),
    listProjects: async () => c.listProjects(),
    projectOverview: (dir) => c.projectOverview(dir),
    forgetProject: async (dir) => c.forgetProject(dir),
    projectBranches: (dir, fetch) => c.projectBranches(dir, fetch),
    cleanWorkingCopy: (dir, how) => c.cleanWorkingCopy(dir, how),
    checkEnvironment: (dir) => c.checkEnvironment(dir),
    nextPartDraft: (id) => c.nextPartDraft(id),
    projectStats: async (dir) => c.projectStats(dir),
    listChats: async () => c.listChats(),
    getChat: async (id) => c.getChat(id),
    createChat: (o) => c.createChat(o),
    updateChat: async (id, patch) => c.updateChat(id, patch),
    deleteChat: (id) => c.deleteChat(id),
    sendChat: (id, text, files) => c.sendChat(id, text, files),
    stopChat: (id) => c.stopChat(id),
    unqueueChat: async (id, messageId) => c.unqueueChat(id, messageId),
    chatToTask: (id) => c.chatToTask(id),
    getChatDiff: (id) => c.getChatDiff(id),
    getChatChangedFiles: (id) => c.getChatChangedFiles(id),
    getManagerChat: async (id) => c.getManagerChat(id),
    askManager: (id, text) => c.askManager(id, text),
    resolveManagerAction: (id, mid, apply) => c.resolveManagerAction(id, mid, apply),
    detectProject: async (dir) => {
      const gitBin = settings.toolPaths.git || which('git', env) || 'git';
      const isRepo = await new Git(gitBin, env).isRepo(dir).catch(() => false);
      return { ...detectProjectCommands(dir), envFiles: findEnvFiles(dir), isRepo, name: path.basename(dir) };
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
    core?.settingsChanged();
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
