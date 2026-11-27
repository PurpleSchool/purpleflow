import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
  utilityProcess,
  webContents,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from 'electron';
import type { CoreCommand, CoreEvent, RunFile } from '@purpleflow/core';
import type { CoreMethod, HostMessage, HostRequest, SettingsPatch } from '../shared/ipc';
import { themeOf } from '../shared/themes';
import { coreSettings, publicSettings, seenVersion, setSeenVersion, settingsReadable, updateSettings } from './settings';
import { releases } from './releases';
import { bugReportUrl } from '../shared/bugReport';
import * as account from './account';
import { proxyModels } from './models';
import { cancelDownload, dictationStatus, downloadModel, fakeMicFromEnv, micAccess, removeModel, transcribe } from './dictation';
import { isSamePage, isWebUrl } from '../shared/urls';
import type { UpdateState } from '../shared/update';
import { errorReportingActive, initErrorReporting } from './error-reporting';
import { chatWebBridge, registerChatTab, startChatWeb } from './chatweb';
import { fetchMedia, mediaModels } from './media';
import { killAllTerminals, killTerminal, openTerminal, resizeTerminal, writeTerminal } from './terminal';
import { ignoreClosedOutput } from './stdio';
import {
  flushUsageEvents,
  recordRunStart,
  recordSetup,
  recordUsage,
  recordUsageCommand,
  recordUsageEvent,
  startUsageEvents,
  syncUsageEvents,
  usageRecording,
} from './usage-events';
import { checkForUpdatesNow, downloadUpdate, installUpdate, reportInstallFailure, startUpdater, updateState } from './updater';

// Отдельный профиль для тестов и разработки.
if (process.env.PURPLEFLOW_USER_DATA) app.setPath('userData', path.resolve(process.env.PURPLEFLOW_USER_DATA));
else {
  // До переименования в PurpleFlow профиль жил в «PS Flow»: там настройки, история и worktree прогонов — остаёмся в нём.
  const legacy = path.join(app.getPath('appData'), 'PS Flow');
  if (fs.existsSync(legacy)) app.setPath('userData', legacy);
}
// e2e: микрофон из файла (PURPLEFLOW_FAKE_MIC) — до старта Chromium.
fakeMicFromEnv();

// После выбора профиля: настройка отчётов лежит в нём.
ignoreClosedOutput();
initErrorReporting();

// Один экземпляр на профиль: второй при старте принял бы живые процессы прогонов первого за брошенные и убил их.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => focusWindow());

type PendingCall = { resolve: (v: unknown) => void; reject: (e: Error) => void };

interface CoreHost {
  process: UtilityProcess;
  ready: Promise<void>;
  pending: Map<number, PendingCall>;
  stopping?: Promise<void>;
}

let win: BrowserWindow | null = null;
let host: CoreHost | null = null;
let startupError: Error | null = null;
let seq = 0;

/** Сквозные тесты: окно не показывается, не берёт фокус, без значка в доке и системных уведомлений. */
const HIDDEN = Boolean(process.env.PURPLEFLOW_HIDDEN);
// Сквозные тесты без звука: сигнал о готовности и звук сайта во вкладке «Браузер» глушит сам Chromium.
if (process.env.PURPLEFLOW_MUTE || HIDDEN) app.commandLine.appendSwitch('mute-audio');

function focusWindow() {
  if (!win || HIDDEN) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const promptsDir = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'prompts') : path.join(app.getAppPath(), '..', 'core', 'prompts');

// ——— Уведомления: прогон ждёт решения, остановился с ошибкой или готов ———

const runInfo = new Map<string, { title: string; status: string }>();
const GATE_WORD: Record<string, string> = {
  gate1: 'утвердите план',
  gate2: 'примите результат',
  limit: 'попытки исчерпаны — решите, что дальше',
};

/** Значок дока сразу после запуска: без этого прогоны, ждущие решения, не считались бы до первого события. */
async function loadBadge() {
  const runs = (await callHost('listRuns', []).catch(() => [])) as { id: string; title: string; status: string }[];
  runInfo.clear();
  for (const r of runs) runInfo.set(r.id, { title: r.title, status: r.status });
  updateBadge();
}

function updateBadge() {
  const waiting = [...runInfo.values()].filter((r) => r.status === 'waiting').length;
  app.setBadgeCount(waiting);
}

function notify(runId: string, title: string, body: string) {
  const s = publicSettings();
  const focused = Boolean(win?.isFocused());
  // В фокусе — только звук в окне; свёрнуто или в фоне — системное уведомление и прыжок значка в доке.
  if (s.sound) win?.webContents.send('app:chime');
  if (!s.notify || focused || HIDDEN || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  n.on('click', () => {
    focusWindow();
    win?.webContents.send('app:go', runId);
  });
  n.show();
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  else win?.flashFrame(true);
}

function attention(e: CoreEvent) {
  if (e.type === 'run.updated') {
    runInfo.set(e.run.id, { title: e.run.title, status: e.run.status });
    updateBadge();
    return;
  }
  if (e.type === 'run.deleted') {
    runInfo.delete(e.runId);
    updateBadge();
    return;
  }
  const title = () => runInfo.get((e as { runId: string }).runId)?.title ?? 'Прогон';
  if (e.type === 'gate.waiting') notify(e.runId, 'Нужно ваше решение', `${title()}: ${GATE_WORD[e.gate] ?? 'ждёт решения'}`);
  else if (e.type === 'run.finished' && e.status === 'finished') notify(e.runId, 'Прогон готов', `${title()}: коммит в ветке, можно влить`);
  else if (e.type === 'run.finished' && e.status === 'stopped' && e.message && !/пользовател/.test(e.message))
    notify(e.runId, 'Прогон остановлен', `${title()}: ${e.message.slice(0, 160)}`);
}

// Восстановление идёт по прогонам последовательно, и каждая git-команда может занять до 60 секунд.
const STARTUP_TIMEOUT_MS = 5 * 60_000;
let restartDelay = 0;
let restartWait: Promise<void> | null = null;

function startHost(): CoreHost {
  if (host) return host;
  const startedAt = Date.now();
  const proc = utilityProcess.fork(path.join(__dirname, 'coreHost.js'), errorReportingActive() ? ['--report-errors'] : [], {
    serviceName: 'PurpleFlow Core',
    stdio: 'inherit',
  });
  let markReady!: () => void;
  let failStart!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failStart = reject;
  });
  const current: CoreHost = { process: proc, ready, pending: new Map() };
  host = current;
  startupError = null;
  let startupFailed = false;
  const finishStartup = () => {
    if (!startupTimer) return false;
    clearTimeout(startupTimer);
    startupTimer = null;
    return true;
  };
  const failInit = (message: string) => {
    if (!finishStartup()) return;
    startupFailed = true;
    const error = new Error(message);
    failStart(error);
    if (host === current) {
      startupError = error;
      void stopHost().catch((err) => console.error('[core-host] shutdown', err));
    }
  };
  let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => failInit(`Ядро не запустилось за ${STARTUP_TIMEOUT_MS / 1000} секунд. Перезапустите приложение.`),
    STARTUP_TIMEOUT_MS,
  );
  proc.on('message', (m: HostMessage) => {
    if (host !== current) return;
    if (m.kind === 'ready') {
      if (!finishStartup()) return;
      restartDelay = 0;
      markReady();
      void loadBadge();
    } else if (m.kind === 'init-failed') {
      failInit(`Не удалось запустить ядро: ${m.error}`);
    } else if (m.kind === 'event') {
      if (startupFailed) return;
      win?.webContents.send('core:event', m.event);
      attention(m.event);
      recordUsageEvent(m.event);
    } else if (m.kind === 'reply') {
      const p = current.pending.get(m.id);
      if (!p) return;
      current.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    }
  });
  proc.once('exit', (code) => {
    const wasCurrent = host === current;
    // Падение при запуске — не окончательный отказ: ниже ядро перезапустится с задержкой, как после любого падения.
    if (finishStartup()) failStart(new Error(`Процесс ядра завершился при запуске (код ${code})`));
    if (wasCurrent) host = null;
    const error = new Error(`Процесс ядра завершился (код ${code})`);
    for (const p of current.pending.values()) p.reject(error);
    current.pending.clear();
    failStart(error);
    if (!wasCurrent || quitting || startupFailed) return;
    // Ядро упало — поднимаем заново; прогоны восстановятся из run.json. Падает сразу — не крутимся в холостую.
    restartDelay = Date.now() - startedAt < 10_000 ? Math.min(30_000, restartDelay * 2 || 1000) : 0;
    restartWait = new Promise((resolve) => {
      setTimeout(() => {
        try {
          if (!quitting && !host) startHost();
        } catch (error) {
          console.error('[core-host] restart', error);
        } finally {
          restartWait = null;
          resolve();
        }
      }, restartDelay);
    });
  });
  const init: HostRequest = {
    kind: 'init',
    dataDir: path.join(app.getPath('userData'), 'data'),
    promptsDir: promptsDir(),
    settings: coreSettings(),
    chatWeb: chatWebBridge() ?? undefined,
  };
  ready.catch(() => {});
  try {
    proc.postMessage(init);
  } catch (error) {
    failInit(`Не удалось запустить ядро: ${error instanceof Error ? error.message : String(error)}`);
  }
  return current;
}

async function callHost(method: CoreMethod, args: unknown[]): Promise<unknown> {
  if (startupError) throw startupError;
  if (installAttempt) throw new Error('Приложение готовится к установке обновления');
  if (quitting || host?.stopping) throw new Error('Ядро останавливается');
  if (!host && restartWait) await restartWait;
  if (startupError) throw startupError;
  if (quitting) throw new Error('Ядро останавливается');
  const current = host ?? startHost();
  await current.ready;
  if (installAttempt) throw new Error('Приложение готовится к установке обновления');
  if (host !== current) throw new Error('Процесс ядра завершился');
  if (quitting || current.stopping) throw new Error('Ядро останавливается');
  const id = ++seq;
  return new Promise((resolve, reject) => {
    current.pending.set(id, { resolve, reject });
    try {
      current.process.postMessage({ kind: 'call', id, method, args } satisfies HostRequest);
    } catch (error) {
      current.pending.delete(id);
      reject(error);
    }
  });
}

type Material = 'vibrancy' | 'acrylic' | 'none';

/**
 * Нативное стекло окна: macOS — vibrancy, Windows 11 22H2+ — acrylic.
 * На Windows 10 и Linux размытия под окном нет — остаётся непрозрачный фон.
 */
function materialFor(enabled: boolean): Material {
  if (!enabled) return 'none';
  if (process.platform === 'darwin') return 'vibrancy';
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0);
    if (build >= 22621) return 'acrylic';
  }
  return 'none';
}

let material: Material = 'none';
/** Фон окна без прозрачности до первой отрисовки — цвет выбранной темы. */
const opaqueBg = () => themeOf(publicSettings().windowTheme).bg;

function applyMaterial(w: BrowserWindow, m: Material) {
  material = m;
  if (process.platform === 'darwin') w.setVibrancy(m === 'vibrancy' ? 'under-window' : null);
  if (process.platform === 'win32' && materialFor(true) === 'acrylic') w.setBackgroundMaterial(m === 'acrylic' ? 'acrylic' : 'none');
  w.setBackgroundColor(m === 'none' ? opaqueBg() : '#00000000');
  w.webContents.send('app:material', m);
}

/** Стандартное меню Electron плюс «Проверить обновления». На Windows и Linux у окна нет полосы меню: там кнопка есть в настройках. */
function setupMenu() {
  const check: MenuItemConstructorOptions = {
    label: 'Проверить обновления…',
    click: () => {
      if (win) focusWindow();
      else createWindow();
      checkForUpdates();
    },
  };
  const shared: MenuItemConstructorOptions[] = [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      process.platform === 'darwin'
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' },
                check,
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
            ...shared,
          ]
        : [...shared, { label: 'Справка', submenu: [check] }],
    ),
  );
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  material = materialFor(publicSettings().windowGlass);
  win = new BrowserWindow({
    // PURPLEFLOW_WIN=ШxВ — размер окна для скриншотов адаптивной вёрстки.
    width: Number(process.env.PURPLEFLOW_WIN?.split('x')[0]) || 1440,
    height: Number(process.env.PURPLEFLOW_WIN?.split('x')[1]) || 920,
    minWidth: process.env.PURPLEFLOW_WIN ? 600 : 900,
    minHeight: 680,
    show: false,
    backgroundColor: material === 'none' ? opaqueBg() : '#00000000',
    vibrancy: material === 'vibrancy' ? 'under-window' : undefined,
    visualEffectState: 'active',
    backgroundMaterial: material === 'acrylic' ? 'acrylic' : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 20, y: 22 },
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#a7a9b1', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Вкладка «Браузер» — <webview> в отдельной сессии; параметры жёстко задаются в will-attach-webview.
      webviewTag: true,
      // Фоновое окно скриншотов не должно притормаживать отрисовку.
      backgroundThrottling: !process.env.PURPLEFLOW_CAPTURE && !HIDDEN,
    },
  });
  nativeTheme.themeSource = 'dark';
  win.once('ready-to-show', () => {
    if (HIDDEN) return;
    // Режим скриншотов не должен перехватывать фокус и клавиатуру у человека.
    if (process.env.PURPLEFLOW_CAPTURE) win?.showInactive();
    else win?.show();
  });
  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Ссылка из Markdown (комментарий PR, ответ агента) или брошенный на окно файл не должны заменять приложение:
  // чужая страница получила бы window.purpleflow со всеми правами окна.
  // Переходы по якорям не вызывают will-navigate и продолжают работать.
  webContents.on('will-navigate', (ev) => {
    // location.reload() тоже идёт через will-navigate: кнопка «Перезагрузить окно» и полная перезагрузка Vite.
    if (ev.url === webContents.getURL()) return;
    ev.preventDefault();
    if (isWebUrl(ev.url) && !isSamePage(ev.url, webContents.getURL())) void shell.openExternal(ev.url);
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
  // Захват скриншотов — инструмент разработки, в собранном приложении не подключается.
  if (process.env.PURPLEFLOW_CAPTURE && !app.isPackaged) void import('./dev-capture').then((m) => m.setupCapture(win!));
}

/**
 * Обработчики — только для главного кадра нашего окна: вторая линия защиты на случай, если чужой документ
 * всё же окажется в окне (у webview нет preload, а окно никуда не уходит — см. will-navigate).
 */
const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) =>
  ipcMain.handle(channel, (e, ...args) => {
    if (e.sender !== win?.webContents || e.senderFrame !== e.sender.mainFrame) throw new Error('Запрос не из окна приложения');
    return fn(e, ...(args as never[]));
  });

const getRun = (id: string) => callHost('getRun', [id]).catch(() => null) as Promise<RunFile | null>;

handle('core:call', async (_e, method: CoreMethod, args: unknown[]) => {
  const cmd = method === 'dispatch' ? (args[0] as CoreCommand) : null;
  // На каких воротах стоял прогон — узнаём до решения: после него прогон уже ушёл дальше.
  const gate = cmd && cmd.type.startsWith('gate.') && 'runId' in cmd && usageRecording() ? (await getRun(cmd.runId))?.next : undefined;
  const result = await callHost(method, args);
  // После успеха: отклонённая команда в статистику не попадает.
  if (cmd) {
    recordUsageCommand(cmd, { gate });
    // Агент, модель и пресет — по самому прогону: ядро могло пересадить роль с выключенного CLI.
    if (cmd.type === 'run.start' && usageRecording())
      void getRun((result as { runId: string }).runId).then((run) => run && recordRunStart(run, Boolean(coreSettings().proxy.baseUrl)));
  }
  return result;
});
// Шаги настройки из окна: проверку шага и причины делает usageFromSetup.
ipcMain.on('usage:setup', (e, step: unknown, reason: unknown) => {
  if (e.sender === win?.webContents) recordSetup(step, reason);
});
handle('settings:get', () => publicSettings());
ipcMain.on('app:error-reports:get', (e) => {
  e.returnValue = errorReportingActive();
});
ipcMain.on('app:material:get', (e) => {
  e.returnValue = material;
});
ipcMain.on('app:theme:get', (e) => {
  e.returnValue = publicSettings().windowTheme;
});
handle('settings:set', (_e, patch: SettingsPatch) => {
  const firstSetup = patch.onboarded === true && !publicSettings().onboarded;
  const s = updateSettings(patch);
  syncUsageEvents();
  if (firstSetup) recordUsage('setup_completed');
  if ((patch.windowGlass !== undefined || patch.windowTheme !== undefined) && win) applyMaterial(win, materialFor(s.windowGlass));
  host?.process.postMessage({ kind: 'settings', settings: coreSettings() } satisfies HostRequest);
  return s;
});
// Аккаунт PurpleSchool. После смены ключа прокси ядро получает новые настройки.
const pushSettings = () => host?.process.postMessage({ kind: 'settings', settings: coreSettings() } satisfies HostRequest);

// Файл настроек не прочитался (нет доступа и т.п.): ядро и окно получили значения по умолчанию.
// Проверяем, пока не прочитается, и тогда отдаём настоящие и ядру, и окну.
const SETTINGS_RETRY_MS = 3000;
let settingsRetry: ReturnType<typeof setInterval> | null = null;
function watchUnreadableSettings() {
  if (settingsRetry || settingsReadable()) return;
  console.error('[settings] файл настроек не читается — до восстановления действуют значения по умолчанию');
  settingsRetry = setInterval(() => {
    if (!settingsReadable()) return;
    clearInterval(settingsRetry!);
    settingsRetry = null;
    pushSettings();
    win?.webContents.send('settings:recovered');
  }, SETTINGS_RETRY_MS);
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
handle('account:login', async (_e, email: unknown, password: unknown) => {
  const r = await account.login(str(email), str(password));
  if (r.ok) pushSettings();
  return r;
});
handle('account:register', async (_e, p: { name?: unknown; email?: unknown; password?: unknown; mailing?: unknown }) => {
  const r = await account.register({ name: str(p?.name), email: str(p?.email), password: str(p?.password), mailing: p?.mailing === true });
  if (r.ok) pushSettings();
  return r;
});
handle('account:restore', (_e, email: unknown) => account.restore(str(email)));
handle('account:logout', () => account.logout());
handle('account:profile', () => account.profile());
handle('account:keys', () => account.keys());
handle('models:list', () => proxyModels());
handle('account:createKey', async () => {
  const r = await account.createKey();
  if (r.ok) pushSettings();
  return r;
});
handle('account:useKey', async (_e, id: unknown) => {
  const r = await account.useKey(Number(id));
  if (r.ok) pushSettings();
  return r;
});
handle('account:autoKey', async () => {
  const r = await account.autoKey();
  if (r.ok && r.data === 'picked') pushSettings();
  return r;
});
handle('account:overview', () => account.overview());
handle('account:initialBalance', () => account.initialBalance());
handle('account:requestEmailCode', () => account.requestEmailCode());
handle('account:confirmEmailCode', (_e, code: unknown) => account.confirmEmailCode(str(code).trim()));
handle('account:claimInitialBalance', () => account.claimInitialBalance());
handle('account:trialModels', () => account.trialModels());
handle('account:mediaModels', () => mediaModels());
handle('account:paidBalance', () => account.paidBalance());
handle('media:fetch', (_e, url: string) => (typeof url === 'string' ? fetchMedia(url) : null));
// Картинка из чата — в файл: человек выбирает, куда сохранить (по умолчанию «Загрузки»). Пишем только то, что он выбрал.
handle('media:save', async (_e, o: { data: Uint8Array; name: string }) => {
  if (!(o?.data instanceof Uint8Array) || typeof o.name !== 'string') return null;
  const name =
    path
      .basename(o.name)
      .replace(/[\\/:*?"<>|]+/g, '-')
      .slice(0, 120) || 'image.png';
  const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), name), title: 'Сохранить картинку' });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, o.data);
  return r.filePath;
});
handle('account:usage', (_e, q: { from?: unknown; to?: unknown; bucket?: unknown; keyIds?: unknown }) =>
  account.usage({
    from: str(q?.from),
    to: str(q?.to),
    bucket: str(q?.bucket) as never,
    keyIds: Array.isArray(q?.keyIds) ? q.keyIds.map(Number) : [],
  }),
);
handle('settings:encryption', () => safeStorage.isEncryptionAvailable());
handle('dialog:folder', async (_e, title?: string) => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory'],
    title: typeof title === 'string' ? title : 'Папка проекта (git-репозиторий)',
  });
  return r.canceled ? null : r.filePaths[0];
});
// Скиллы, положенные руками, — в корзину системы. Только папка скилла или файл команды внутри каталогов агентов
// (.claude/skills, .agents/skills, …/commands, .codex/prompts): ничего другого окно так удалить не может.
handle('skills:trash', async (_e, paths: unknown) => {
  if (!Array.isArray(paths)) throw new Error('Нет путей');
  const holders = new Set(['skills', 'skill', 'commands', 'command', 'prompts']);
  // Папки агентов, в которых лежат каталоги скиллов: .claude/skills, ~/.config/opencode/skill, ~/.gemini/config/skills…
  const agentDirs = new Set(['.claude', '.agents', '.codex', '.opencode', 'opencode', 'config']);
  for (const p of paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Неверный путь');
    const parts = path.resolve(p).split(path.sep);
    const ok = parts.some((x, i) => holders.has(x) && i > 0 && agentDirs.has(parts[i - 1]) && i < parts.length - 1);
    if (!ok) throw new Error(`Это не скилл: ${p}`);
    if (fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false })) await shell.trashItem(p);
  }
});
handle('dictation:status', () => dictationStatus());
handle('dictation:download', (_e, id: string) =>
  downloadModel(String(id), (share) => win?.webContents.send('dictation:progress', String(id), share)),
);
handle('dictation:cancel', (_e, id: string) => cancelDownload(String(id)));
handle('dictation:remove', (_e, id: string) => removeModel(String(id)));
handle('dictation:mic', () => micAccess());
handle('dictation:transcribe', (_e, wav: Uint8Array, model: string, lang: string) => {
  if (!(wav instanceof Uint8Array)) throw new Error('Нет записи');
  return transcribe(wav, String(model), String(lang));
});
handle('dialog:file', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'showHiddenFiles'], title: 'Исполняемый файл' });
  return r.canceled ? null : r.filePaths[0];
});
// ——— Вкладка «Браузер»: приложение проекта во встроенном webview ———

const PREVIEW_PARTITION = 'purpleflow-preview';
/** Во вкладке «Браузер» открываются сайты по http(s) и пустая новая вкладка; file:, chrome: и прочее — нет. */
const browsable = (u: string) => isWebUrl(u) || u === 'about:blank';
/** Вкладки прогона (визуальная проверка, самопроверка) — своя сессия на прогон: куки задач не смешиваются с чатами. */
const RUN_PARTITION = /^purpleflow-run-[\w-]{1,80}$/;
const guarded = new Set<string>();
/** Сессия вкладки «Браузер»: сайты не получают камеру, микрофон, геолокацию и уведомления и ничего не скачивают. */
function guardPreviewSession(partition = PREVIEW_PARTITION) {
  if (guarded.has(partition)) return;
  guarded.add(partition);
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (ev) => ev.preventDefault());
}
app.on('web-contents-created', (_e, contents) => {
  // webview — без preload и Node, в своей сессии, только http(s).
  contents.on('will-attach-webview', (ev, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    if ((params.partition !== PREVIEW_PARTITION && !RUN_PARTITION.test(params.partition)) || !browsable(params.src))
      return ev.preventDefault();
    guardPreviewSession(params.partition);
  });
  if (contents.getType() === 'webview') {
    // Ссылка в новое окно — новая вкладка браузера в окне приложения.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) contents.hostWebContents?.send('preview:new-tab', contents.id, url);
      return { action: 'deny' };
    });
    const keepWeb = (ev: { preventDefault: () => void }, url: string) => {
      if (!browsable(url)) ev.preventDefault();
    };
    // Окно прозрачное (vibrancy), и webview его наследует: страница без своего фона просвечивала бы серым.
    // Белый — на уровне стилей пользователя: свой фон сайта всегда важнее.
    contents.on('dom-ready', () => void contents.insertCSS('html { background-color: #fff; }', { cssOrigin: 'user' }).catch(() => {}));
    contents.on('will-navigate', keepWeb);
    contents.on('will-redirect', keepWeb);
    // loadURL из адресной строки вкладки — ни will-navigate, ни will-redirect не срабатывают.
    contents.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !browsable(d.url)) contents.stop();
    });
  }
});

// Браузер чата: окно сообщает о новой вкладке (webview) — мост отдаёт её агенту чата.
// Терминал панели чата: оболочка в PTY — у каждого окна свои.
handle('term:open', (e, o: { cwd: string; cols: number; rows: number }) => openTerminal(e.sender, o));
handle('term:resize', (e, id: number, cols: number, rows: number) => resizeTerminal(e.sender, id, cols, rows));
handle('term:kill', (e, id: number) => killTerminal(e.sender, id));
ipcMain.on('term:write', (e, id: number, data: string) => writeTerminal(e.sender, id, data));

handle('chatweb:tab', (e, chatId: string, wcId: number, reqId?: string) => registerChatTab(e.sender, chatId, wcId, reqId));

handle('preview:emulate', (e, id: number, mobile: boolean) => {
  const wc = webContents.fromId(id);
  // Только webview нашего окна.
  if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== e.sender) return;
  // Ширину 390 задаёт рамка во вкладке; enableDeviceEmulation в webview ломает отрисовку — меняем только user agent.
  const userAgent = mobile
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    : app.userAgentFallback;
  // dom-ready fires after reload. Reapplying the same agent there would reload forever.
  if (wc.getUserAgent() === userAgent) return;
  wc.setUserAgent(userAgent);
  wc.reload();
});

// ——— Кэш Chromium приложения (HTTP, скомпилированный код, шейдеры) ———
const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache', 'Shared Dictionary'];
function dirBytes(p: string): number {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((n, e) => n + dirBytes(path.join(p, e)), 0);
  } catch {
    return 0;
  }
}
handle('cache:size', () => CACHE_DIRS.reduce((n, d) => n + dirBytes(path.join(app.getPath('userData'), d)), 0));
handle('cache:clear', async () => {
  for (const s of [session.defaultSession, session.fromPartition(PREVIEW_PARTITION)]) {
    await s.clearCache();
    await s.clearCodeCaches({});
  }
  // Сайты проектов из вкладки «Браузер»: куки и localStorage тестовых входов.
  await session.fromPartition(PREVIEW_PARTITION).clearStorageData();
});

handle('shell:open', (_e, p: string) => shell.openPath(p).then(() => undefined));

let quitting = false;
/** «Стоп» для всего: убиваем деревья процессов агентов и тестов и само ядро. Зависшее ядро не держит выход дольше 5 секунд. */
function stopHost(): Promise<void> {
  const current = host;
  if (!current) return Promise.resolve();
  current.stopping ??= new Promise((resolve) => {
    const { process: proc, pending } = current;
    const id = ++seq;
    const finish = () => {
      clearTimeout(timer);
      pending.delete(id);
      proc.off('exit', finish);
      resolve();
    };
    const requestExit = () => {
      try {
        proc.kill();
      } catch (error) {
        console.error('[core-host] shutdown', error);
      }
    };
    const timer = setTimeout(() => {
      requestExit();
      finish();
    }, 5000);
    // kill() только запрашивает завершение. Пока не пришёл exit, этот процесс остаётся текущим.
    proc.once('exit', finish);
    pending.set(id, { resolve: requestExit, reject: () => {} });
    try {
      proc.postMessage({ kind: 'shutdown', id } satisfies HostRequest);
    } catch {
      pending.delete(id);
      requestExit();
    }
  });
  return current.stopping;
}

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void Promise.allSettled([stopHost(), flushUsageEvents()]).then(() => app.quit());
});

// Некоторые установщики запрашивают выход асинхронно.
const INSTALL_QUIT_TIMEOUT_MS = 30_000;
type InstallAttempt = { timer?: ReturnType<typeof setTimeout> };
let installAttempt: InstallAttempt | undefined;

function resumeAfterInstallFailure() {
  clearTimeout(installAttempt?.timer);
  installAttempt = undefined;
  quitting = false;
  // Пока старый процесс завершает работу, перезапуск выполнит его обработчик exit.
  if (!host && !restartWait) startHost();
}

app.on('will-quit', () => {
  clearTimeout(installAttempt?.timer);
  killAllTerminals();
});

const onUpdateState = (u: UpdateState) => {
  if (installAttempt?.timer && u.kind === 'failed') resumeAfterInstallFailure();
  win?.webContents.send('update:state', u);
};
/** Ручная проверка возвращает и скрытое кнопкой «Позже»: пользователь сам спросил про обновление. */
const checkForUpdates = () => {
  win?.webContents.send('update:reveal');
  checkForUpdatesNow();
};
handle('update:state', () => updateState());
handle('update:check', () => checkForUpdates());
handle('update:download', () => downloadUpdate());
const OS_NAME: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
handle('app:reportBug', (_e, tools: { name: string; version?: string }[]) =>
  shell.openExternal(
    bugReportUrl({
      version: app.getVersion(),
      os: `${OS_NAME[process.platform] ?? process.platform} ${process.getSystemVersion()}`,
      arch: process.arch,
      electron: process.versions.electron,
      tools: Array.isArray(tools) ? tools.slice(0, 10) : [],
    }),
  ),
);
handle('whatsNew:releases', () => releases());
handle('whatsNew:versions', () => ({ current: app.getVersion(), seen: seenVersion(app.getVersion()) }));
handle('whatsNew:seen', () => setSeenVersion(app.getVersion()));
handle('update:install', async () => {
  if (installAttempt) return;
  if (quitting) throw new Error('Приложение завершает работу');
  const update = updateState();
  if (update.kind !== 'ready') throw new Error('Обновление ещё не готово к установке');

  const attempt: InstallAttempt = {};
  installAttempt = attempt;
  quitting = true;
  const fail = (message: string) => {
    if (installAttempt !== attempt) return;
    resumeAfterInstallFailure();
    reportInstallFailure(update.version, message);
  };
  try {
    await Promise.all([stopHost(), flushUsageEvents()]);
    const current = updateState();
    // Пока останавливалось ядро, состояние обновления сменилось. Не молчим: сбой фоновой проверки окно уже показывает,
    // остальное сообщаем сами.
    if (current.kind !== 'ready') {
      resumeAfterInstallFailure();
      if (current.kind !== 'failed') reportInstallFailure(update.version, 'Обновление больше не готово к установке — попробуйте ещё раз');
      return;
    }
    // Успела скачаться более новая версия — ставим её: установщик берёт последнюю скачанную.
    attempt.timer = setTimeout(() => fail('Установщик не запросил перезапуск приложения'), INSTALL_QUIT_TIMEOUT_MS);
    installUpdate();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

handle('notify:test', () => {
  const s = publicSettings();
  if (s.sound) win?.webContents.send('app:chime');
  if (s.notify && !HIDDEN && Notification.isSupported())
    new Notification({
      title: 'PurpleFlow',
      body: 'Так будут выглядеть уведомления, когда прогону нужно ваше внимание.',
      silent: true,
    }).show();
});

app.whenReady().then(async () => {
  if (!primary) return;
  // Мост браузера чата — до ядра: ядру при старте нужен его адрес.
  await startChatWeb(() => (win && !win.isDestroyed() ? win.webContents : null)).catch((e) => console.error('[chatweb]', e));
  // Сквозные тесты на Linux-раннере: системного хранилища ключей нет, а без шифрования ключ и токен не сохранить.
  // Встроенный ключ — только для тестов; обычный запуск по-прежнему требует libsecret или KWallet.
  if (process.platform === 'linux' && process.env.PURPLEFLOW_E2E_PLAIN_STORAGE) safeStorage.setUsePlainTextEncryption(true);
  // Сайт проекта во вкладке «Браузер» не получает разрешений (камера, геолокация, уведомления…).
  session.fromPartition(PREVIEW_PARTITION).setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  if ((process.env.PURPLEFLOW_CAPTURE || HIDDEN) && process.platform === 'darwin') app.dock?.hide();
  watchUnreadableSettings();
  startHost();
  setupMenu();
  createWindow();
  startUpdater(onUpdateState);
  startUsageEvents();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
