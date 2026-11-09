import { app } from 'electron';
import type { CoreCommand, CoreEvent } from '@purpleflow/core';
import { UsageQueue, usageFromCommand, usageFromCoreEvent, type UsageEvent, type UsageSendResult } from '../shared/usage-events';
import { ACCOUNT_API, ACCOUNT_ENABLED, USAGE_EVENTS_FLAG } from './provider';
import { usageEventsAllowed, usageInstallId } from './settings';

const FLUSH_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 5_000;

/** Собранное приложение с аккаунтом PurpleSchool; в разработке — только с PURPLEFLOW_USAGE_EVENTS=on. */
export function usageEventsActive(): boolean {
  if (!ACCOUNT_ENABLED || /^(off|0|false|no)$/i.test(USAGE_EVENTS_FLAG)) return false;
  return app.isPackaged || /^(on|1|true|yes)$/i.test(USAGE_EVENTS_FLAG);
}

async function send(events: UsageEvent[]): Promise<UsageSendResult> {
  try {
    const res = await fetch(`${ACCOUNT_API}/public/purpleflow/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
export const recordUsageCommand = (cmd: CoreCommand) => record(usageFromCommand(cmd));
export const recordUsageEvent = (e: CoreEvent) => record(usageFromCoreEvent(e));

/** Выключатель действует сразу: накопленное не уходит. */
export function syncUsageEvents() {
  if (!usageEventsAllowed()) queue.clear();
}

export const flushUsageEvents = () => (usageEventsActive() ? queue.flush() : Promise.resolve());

export function startUsageEvents() {
  if (!usageEventsActive()) return;
  recordUsage('app_opened');
  setInterval(() => void queue.flush(), FLUSH_INTERVAL_MS).unref();
}
