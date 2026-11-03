// Автообновление: проверка релизов GitHub, загрузка и установка только по решению пользователя.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { nextUpdateState, type UpdateEvent, type UpdateState } from '../shared/update';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15_000;

let state: UpdateState = { kind: 'idle' };

export const updateState = () => state;

export function startUpdater(onChange: (s: UpdateState) => void) {
  // Только для сквозных тестов: своя лента вместо GitHub. В упакованном приложении адрес не подменить.
  const testFeed = app.isPackaged ? undefined : process.env.PURPLEFLOW_UPDATE_URL;
  if (!app.isPackaged && !testFeed) return;

  const dispatch = (e: UpdateEvent) => {
    state = nextUpdateState(state, e);
    onChange(state);
  };
  autoUpdater.autoDownload = false;
  // «Позже» на готовом обновлении: оно поставится при обычном выходе.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed });
  }
  autoUpdater.on('update-available', (i) => dispatch({ type: 'available', version: i.version }));
  autoUpdater.on('download-progress', (p) => dispatch({ type: 'progress', percent: p.percent }));
  autoUpdater.on('update-downloaded', (i) => dispatch({ type: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => dispatch({ type: 'error', message: e.message.split('\n')[0] }));

  // Ошибка придёт и событием; здесь только не даём ей стать необработанной.
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, testFeed ? 0 : FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS).unref();
}

export function downloadUpdate(onChange: (s: UpdateState) => void) {
  state = nextUpdateState(state, { type: 'download-started' });
  onChange(state);
  void autoUpdater.downloadUpdate().catch(() => {});
}

export const installUpdate = () => autoUpdater.quitAndInstall();
