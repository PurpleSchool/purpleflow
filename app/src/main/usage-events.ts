import { app } from 'electron';
import type { CoreCommand, CoreEvent, RunFile } from '@purpleflow/core';
import {
  UsageQueue,
  usageFromCommand,
  usageFromCoreEvent,
  usageFromRunStart,
  usageFromSetup,
  type CommandContext,
  type UsageEvent,
  type UsageSendResult,
} from '../shared/usage-events';
import { ACCOUNT_API, ACCOUNT_ENABLED, USAGE_EVENTS_FLAG } from './provider';
import { accountToken, usageEventsAllowed, usageFirstLaunch, usageInstallId } from './settings';

const FLUSH_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 5_000;

/** Собранное приложение с аккаунтом PurpleSchool; в разработке — только с PURPLEFLOW_USAGE_EVENTS=on. */
export function usageEventsActive(): boolean {
  if (!ACCOUNT_ENABLED || /^(off|0|false|no)$/i.test(USAGE_EVENTS_FLAG)) return false;
  return app.isPackaged || /^(on|1|true|yes)$/i.test(USAGE_EVENTS_FLAG);
}

async function send(events: UsageEvent[]): Promise<UsageSendResult> {
  const token = accountToken();
  try {
    const res = await fetch(`${ACCOUNT_API}/public/purpleflow/events`, {
      method: 'POST',
      // Вошли через PurpleSchool — токен: сервер сам возьмёт из него пользователя. Из тела запроса он id не принимает.
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ installId: usageInstallId(), appVersion: app.getVersion(), os: process.platform, events }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return 'sent';
    return res.status === 400 ? 'rejected' : 'failed';
  } catch {
    return 'failed';
  }
}

const queue = new UsageQueue(send);

function record(draft: Omit<UsageEvent, 'occurredAt'> | null) {
  if (!draft || !usageEventsActive() || !usageEventsAllowed()) return;
  queue.push({ ...draft, occurredAt: new Date().toISOString() });
}

export const recordUsage = (name: string) => record({ name });
export const recordUsageCommand = (cmd: CoreCommand, ctx?: CommandContext) => record(usageFromCommand(cmd, ctx));
export const recordUsageEvent = (e: CoreEvent) => record(usageFromCoreEvent(e));
export const recordRunStart = (run: RunFile, proxy: boolean) => record(usageFromRunStart(run, proxy));
export const recordSetup = (step: unknown, reason?: unknown) => record(usageFromSetup(step, reason));

/** Писать ли статистику сейчас — чтобы не делать лишних запросов к ядру ради неё. */
export const usageRecording = () => usageEventsActive() && usageEventsAllowed();

/** Выключатель действует сразу: накопленное не уходит. */
export function syncUsageEvents() {
  if (!usageEventsAllowed()) queue.clear();
}

export async function flushUsageEvents() {
  if (!usageEventsActive()) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SEND_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.error('[usage-events] flush', error);
  } finally {
    clearTimeout(timeout);
  }
}

export function startUsageEvents() {
  if (!usageEventsActive()) return;
  // До usageInstallId(): он заводится при первой отправке, после этого запуск уже не первый.
  if (usageFirstLaunch() && usageEventsAllowed()) {
    recordUsage('app_first_launch');
    usageInstallId();
  }
  recordUsage('app_opened');
  setInterval(() => void queue.flush(), FLUSH_INTERVAL_MS).unref();
}
