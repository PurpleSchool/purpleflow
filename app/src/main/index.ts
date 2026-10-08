import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, Notification, app, dialog, ipcMain, nativeTheme, safeStorage, session, shell, utilityProcess, webContents, type UtilityProcess } from 'electron';
import type { CoreEvent } from '@psflow/core';
import type { CoreMethod, HostMessage, HostRequest, SettingsPatch } from '../shared/ipc';
import { coreSettings, publicSettings, updateSettings } from './settings';

// Отдельный профиль для тестов и разработки.
if (process.env.PSFLOW_USER_DATA) app.setPath('userData', path.resolve(process.env.PSFLOW_USER_DATA));
else {
  // До переименования в PurpleFlow профиль жил в «PS Flow»: там настройки, история и worktree прогонов — остаёмся в нём.
  const legacy = path.join(app.getPath('appData'), 'PS Flow');
  if (fs.existsSync(legacy)) app.setPath('userData', legacy);
}

// Один экземпляр на профиль: второй при старте принял бы живые процессы прогонов первого за брошенные и убил их.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

let win: BrowserWindow | null = null;
let host: UtilityProcess | null = null;
let ready: Promise<void> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const promptsDir = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'prompts') : path.join(app.getAppPath(), '..', 'core', 'prompts');

// ——— Уведомления: прогон ждёт решения, остановился с ошибкой или готов ———

const runInfo = new Map<string, { title: string; status: string }>();
const GATE_WORD: Record<string, string> = { gate1: 'утвердите план', gate2: 'примите результат', limit: 'попытки исчерпаны — решите, что дальше' };

function updateBadge() {
  const waiting = [...runInfo.values()].filter((r) => r.status === 'waiting').length;
  app.setBadgeCount(waiting);
}

function notify(runId: string, title: string, body: string) {
  const s = publicSettings();
  const focused = Boolean(win?.isFocused());
  // В фокусе — только звук в окне; свёрнуто или в фоне — системное уведомление и прыжок значка в доке.
  if (s.sound) win?.webContents.send('app:chime');
  if (!s.notify || focused || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('app:go', runId);
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
  else if (e.type === 'run.finished' && e.status === 'stopped' && e.message && !/пользовател/.test(e.message)) notify(e.runId, 'Прогон остановлен', `${title()}: ${e.message.slice(0, 160)}`);
}

function startHost(): Promise<void> {
  host = utilityProcess.fork(path.join(__dirname, 'coreHost.js'), [], { serviceName: 'PurpleFlow Core', stdio: 'inherit' });
  ready = new Promise((resolve) => {
    host!.on('message', (m: HostMessage) => {
      if (m.kind === 'ready') resolve();
      else if (m.kind === 'event') {
        win?.webContents.send('core:event', m.event);
        attention(m.event);
      }
      else if (m.kind === 'reply') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error));
      }
    });
  });
  host.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`Процесс ядра завершился (код ${code})`));
    pending.clear();
    host = null;
    // Ядро упало — поднимаем заново; прогоны восстановятся из run.json.
    if (!quitting) void startHost();
  });
  const init: HostRequest = {
    kind: 'init',
    dataDir: path.join(app.getPath('userData'), 'data'),
    promptsDir: promptsDir(),
    settings: coreSettings(),
  };
  host.postMessage(init);
  return ready;
}

async function callHost(method: CoreMethod, args: unknown[]): Promise<unknown> {
  if (!host) await startHost();
  await ready;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host!.postMessage({ kind: 'call', id, method, args } satisfies HostRequest);
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
const OPAQUE_BG = '#0a0b0d';

function applyMaterial(w: BrowserWindow, m: Material) {
  material = m;
  if (process.platform === 'darwin') w.setVibrancy(m === 'vibrancy' ? 'under-window' : null);
  if (process.platform === 'win32' && materialFor(true) === 'acrylic') w.setBackgroundMaterial(m === 'acrylic' ? 'acrylic' : 'none');
  w.setBackgroundColor(m === 'none' ? OPAQUE_BG : '#00000000');
  w.webContents.send('app:material', m);
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  material = materialFor(publicSettings().windowGlass);
  win = new BrowserWindow({
    // PSFLOW_WIN=ШxВ — размер окна для скриншотов адаптивной вёрстки.
    width: Number(process.env.PSFLOW_WIN?.split('x')[0]) || 1440,
    height: Number(process.env.PSFLOW_WIN?.split('x')[1]) || 920,
    minWidth: process.env.PSFLOW_WIN ? 600 : 900,
    minHeight: 680,
    show: false,
    backgroundColor: material === 'none' ? OPAQUE_BG : '#00000000',
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
      backgroundThrottling: !process.env.PSFLOW_CAPTURE,
    },
  });
  nativeTheme.themeSource = 'dark';
  win.once('ready-to-show', () => {
    // Режим скриншотов не должен перехватывать фокус и клавиатуру у человека.
    if (process.env.PSFLOW_CAPTURE) win?.showInactive();
    else win?.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
  // Захват скриншотов — инструмент разработки, в собранном приложении не подключается.
  if (process.env.PSFLOW_CAPTURE && !app.isPackaged) void import('./dev-capture').then((m) => m.setupCapture(win!));
}

ipcMain.handle('core:call', (_e, method: CoreMethod, args: unknown[]) => callHost(method, args));
ipcMain.handle('settings:get', () => publicSettings());
ipcMain.on('app:material:get', (e) => {
  e.returnValue = material;
});
ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => {
  const s = updateSettings(patch);
  if (patch.windowGlass !== undefined && win) applyMaterial(win, materialFor(s.windowGlass));
  host?.postMessage({ kind: 'settings', settings: coreSettings() } satisfies HostRequest);
  return s;
});
ipcMain.handle('settings:encryption', () => safeStorage.isEncryptionAvailable());
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Папка проекта (git-репозиторий)' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:file', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'showHiddenFiles'], title: 'Исполняемый файл' });
  return r.canceled ? null : r.filePaths[0];
});
// ——— Вкладка «Браузер»: приложение проекта во встроенном webview ———

const PREVIEW_PARTITION = 'psflow-preview';
const isLocalUrl = (u: string) => {
  try {
    const { protocol, hostname } = new URL(u);
    return /^https?:$/.test(protocol) && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
};

app.on('web-contents-created', (_e, contents) => {
  // webview — только для приложения проекта: без preload и Node, в своей сессии, только локальные адреса.
  contents.on('will-attach-webview', (ev, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    if (params.partition !== PREVIEW_PARTITION || !isLocalUrl(params.src)) ev.preventDefault();
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (isLocalUrl(url)) void contents.loadURL(url);
      else if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (ev, url) => {
      if (!isLocalUrl(url)) {
        ev.preventDefault();
        if (/^https?:/.test(url)) void shell.openExternal(url);
      }
    });
  }
});

ipcMain.handle('preview:emulate', (e, id: number, mobile: boolean) => {
  const wc = webContents.fromId(id);
  // Только webview нашего окна.
  if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== e.sender) return;
  // Ширину 390 задаёт рамка во вкладке; enableDeviceEmulation в webview ломает отрисовку — меняем только user agent.
  wc.setUserAgent(mobile
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    : app.userAgentFallback);
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
ipcMain.handle('cache:size', () => CACHE_DIRS.reduce((n, d) => n + dirBytes(path.join(app.getPath('userData'), d)), 0));
ipcMain.handle('cache:clear', async () => {
  for (const s of [session.defaultSession, session.fromPartition(PREVIEW_PARTITION)]) {
    await s.clearCache();
    await s.clearCodeCaches({});
  }
  // Сайты проектов из вкладки «Браузер»: куки и localStorage тестовых входов.
  await session.fromPartition(PREVIEW_PARTITION).clearStorageData();
});

ipcMain.handle('shell:open', (_e, p: string) => shell.openPath(p).then(() => undefined));

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !host) return;
  // «Стоп» для всего: перед выходом убиваем деревья процессов агентов и тестов.
  e.preventDefault();
  quitting = true;
  const id = ++seq;
  const done = () => {
    host?.kill();
    app.quit();
  };
  const t = setTimeout(done, 5000);
  pending.set(id, { resolve: () => { clearTimeout(t); done(); }, reject: () => { clearTimeout(t); done(); } });
  host.postMessage({ kind: 'shutdown', id } satisfies HostRequest);
});

ipcMain.handle('notify:test', () => {
  const s = publicSettings();
  if (s.sound) win?.webContents.send('app:chime');
  if (s.notify && Notification.isSupported()) new Notification({ title: 'PurpleFlow', body: 'Так будут выглядеть уведомления, когда прогону нужно ваше внимание.', silent: true }).show();
});

app.whenReady().then(() => {
  if (!primary) return;
  // Сайт проекта во вкладке «Браузер» не получает разрешений (камера, геолокация, уведомления…).
  session.fromPartition(PREVIEW_PARTITION).setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  if (process.env.PSFLOW_CAPTURE && process.platform === 'darwin') app.dock?.hide();
  void startHost();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
