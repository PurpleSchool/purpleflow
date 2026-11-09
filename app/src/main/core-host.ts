// Ядро оркестратора в отдельном utilityProcess: окно не подвисает ни от агентов, ни от git.
import { init as initErrorReporting } from '@sentry/electron/utility';
import { Orchestrator, killAll, loadLoginShellEnv, type CoreSettings } from '@purpleflow/core';
import { coreMethodNames, type CoreApi, type HostMessage, type HostRequest } from '../shared/ipc';

if (process.argv.includes('--report-errors')) initErrorReporting();

const port = process.parentPort;
let settings: CoreSettings;
let core: Orchestrator | null = null;

const send = (m: HostMessage) => port.postMessage(m);

/** Только методы из реестра: окно не может вызвать внутренности ядра по имени. */
function api(c: Orchestrator): CoreApi {
  return Object.fromEntries(coreMethodNames.map((m) => [m, c[m].bind(c)])) as unknown as CoreApi;
}

let methods: CoreApi | null = null;

port.on('message', async (e: { data: HostRequest }) => {
  const msg = e.data;
  if (msg.kind === 'init') {
    settings = msg.settings as CoreSettings;
    const env = loadLoginShellEnv(process.env);
    core = new Orchestrator({ dataDir: msg.dataDir, promptsDir: msg.promptsDir, env, getSettings: () => settings });
    // Подписка до восстановления: события recover не должны теряться.
    core.on((event) => send({ kind: 'event', event }));
    methods = api(core);
    try {
      await core.recover();
    } catch (err) {
      // Прогоны не восстановились — но остальное работает, а вызовы окна не должны висеть вечно.
      console.error('[core-host] recover', err);
    }
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
      const fn = Object.hasOwn(methods, msg.method) ? (methods[msg.method] as (...a: unknown[]) => Promise<unknown>) : undefined;
      if (!fn) throw new Error('Эта функция появилась в новой версии — перезапустите приложение.');
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
