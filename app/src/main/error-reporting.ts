import os from 'node:os';
import { app } from 'electron';
import { IPCMode, init } from '@sentry/electron/main';
import { scrubEvent } from '../shared/error-report';
import { ERROR_REPORTS_DSN, ERROR_REPORTS_FLAG } from './provider';
import { errorReportsAllowed } from './settings';

/**
 * Только то, что нужно для падений. Без минидампов (в них память процесса), снимков экрана, журнала действий и
 * сессий (GlitchTip их не поддерживает).
 */
const KEPT_INTEGRATIONS = new Set([
  'AdditionalContext',
  'ElectronContext',
  'EventFilters',
  'FunctionToString',
  'LinkedErrors',
  'NodeContext',
  'NormalizePaths',
  'OnUncaughtException',
  'OnUnhandledRejection',
]);

/** Собранное приложение; в разработке — только с PURPLEFLOW_ERROR_REPORTS=on. */
export function errorReportingActive(): boolean {
  if (!ERROR_REPORTS_DSN || /^(off|0|false|no)$/i.test(ERROR_REPORTS_FLAG)) return false;
  return app.isPackaged || /^(on|1|true|yes)$/i.test(ERROR_REPORTS_FLAG);
}

/** Зовётся до готовности приложения. Отчёты окна и ядра приходят сюда же, поэтому выключатель и очистка — в одном месте. */
export function initErrorReporting() {
  if (!errorReportingActive()) return;
  init({
    dsn: ERROR_REPORTS_DSN,
    release: `purpleflow@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
    // Classic: без своей схемы sentry-ipc://, до которой могли бы достучаться страницы вкладки «Браузер».
    ipcMode: IPCMode.Classic,
    integrations: (defaults) => defaults.filter((i) => KEPT_INTEGRATIONS.has(i.name)),
    beforeSend: (event) => (errorReportsAllowed() ? scrubEvent(event, os.homedir()) : null),
  });
}
