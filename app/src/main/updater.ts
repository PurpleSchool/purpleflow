// Автообновление: проверка релизов GitHub, загрузка и установка только по решению пользователя.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { nextUpdateState, type UpdateEvent, type UpdateState } from '../shared/update';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15_000;

let state: UpdateState = { kind: 'idle' };
let active = false;
let emit: (s: UpdateState) => void = () => {};

export const updateState = () => state;

const dispatch = (e: UpdateEvent) => {
  state = nextUpdateState(state, e);
  emit(state);
};
const failure = (e: Error): UpdateEvent => ({ type: 'error', message: e.message.split('\n')[0] });

export function startUpdater(onChange: (s: UpdateState) => void) {
  emit = onChange;
  // Только для сквозных тестов: своя лента вместо GitHub. В упакованном приложении адрес не подменить.
  const testFeed = app.isPackaged ? undefined : process.env.PURPLEFLOW_UPDATE_URL;
  if (!app.isPackaged && !testFeed) return;

  active = true;
  autoUpdater.autoDownload = false;
  // «Позже» на готовом обновлении: оно поставится при обычном выходе.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed });
  }
  autoUpdater.on('update-not-available', () => dispatch({ type: 'not-available', version: app.getVersion() }));
  autoUpdater.on('update-available', (i) => dispatch({ type: 'available', version: i.version }));
  autoUpdater.on('download-progress', (p) => dispatch({ type: 'progress', percent: p.percent }));
  autoUpdater.on('update-downloaded', (i) => dispatch({ type: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => dispatch(failure(e)));

  // Ошибка придёт и событием; здесь только не даём ей стать необработанной.
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, testFeed ? 0 : FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS).unref();
}

/** Проверка по просьбе пользователя: в отличие от фоновой показывает и «версия последняя», и сбой. */
export function checkForUpdatesNow() {
  // Уже проверяем, скачиваем или всё готово: новая проверка ни к чему, окно покажет текущее состояние.
  if (state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'ready') return;
  dispatch({ type: 'check-started' });
  if (!active) return dispatch({ type: 'error', message: 'Обновления работают только в собранном приложении' });
  void autoUpdater.checkForUpdates().catch((e: Error) => dispatch(failure(e)));
}

export function downloadUpdate() {
  dispatch({ type: 'download-started' });
  void autoUpdater.downloadUpdate().catch(() => {});
}

export const installUpdate = () => autoUpdater.quitAndInstall();
