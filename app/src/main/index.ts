import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, safeStorage, shell, utilityProcess, type UtilityProcess } from 'electron';
import type { CoreMethod, HostMessage, HostRequest, SettingsPatch } from '../shared/ipc';
import { coreSettings, publicSettings, updateSettings } from './settings';

// Отдельный профиль для тестов и разработки.
if (process.env.PSFLOW_USER_DATA) app.setPath('userData', path.resolve(process.env.PSFLOW_USER_DATA));
else {
  // До переименования в PurpleFlow профиль жил в «PS Flow»: там настройки, история и worktree прогонов — остаёмся в нём.
  const legacy = path.join(app.getPath('appData'), 'PS Flow');
  if (fs.existsSync(legacy)) app.setPath('userData', legacy);
}

let win: BrowserWindow | null = null;
let host: UtilityProcess | null = null;
let ready: Promise<void> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const promptsDir = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'prompts') : path.join(app.getAppPath(), '..', 'core', 'prompts');

function startHost(): Promise<void> {
  host = utilityProcess.fork(path.join(__dirname, 'coreHost.js'), [], { serviceName: 'PurpleFlow Core', stdio: 'inherit' });
  ready = new Promise((resolve) => {
    host!.on('message', (m: HostMessage) => {
      if (m.kind === 'ready') resolve();
      else if (m.kind === 'event') win?.webContents.send('core:event', m.event);
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
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#a7a9b1', height: 60 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
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
  if (process.env.PSFLOW_CAPTURE) setupCapture(win);
}

/**
 * Dev-инструмент: PSFLOW_CAPTURE=out.png [PSFLOW_CAPTURE_JS="…"] [PSFLOW_CAPTURE_DELAY=ms] —
 * выполнить JS в окне, снять скриншот и выйти. Используется для визуальной проверки без ручного кликанья.
 */
function setupCapture(w: BrowserWindow) {
  w.webContents.once('did-finish-load', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(Number(process.env.PSFLOW_CAPTURE_DELAY ?? 2500));
    const shots = (process.env.PSFLOW_CAPTURE ?? '').split(',');
    const scripts = (process.env.PSFLOW_CAPTURE_JS ?? '').split('|||');
    for (let i = 0; i < shots.length; i++) {
      if (scripts[i]) {
        await w.webContents.executeJavaScript(scripts[i]).catch((e) => console.error('[capture]', e));
        await wait(Number(process.env.PSFLOW_CAPTURE_STEP ?? 1500));
      }
      const img = await w.webContents.capturePage();
      fs.writeFileSync(shots[i], img.toPNG());
    }
    if (!process.env.PSFLOW_CAPTURE_KEEP) app.quit();
  });
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

app.whenReady().then(() => {
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
