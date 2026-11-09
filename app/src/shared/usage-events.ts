import type { CoreCommand, CoreEvent } from '@purpleflow/core';

/**
 * Анонимная статистика: какие шаги проходят задачи. Сервер принимает только события и значения из своего белого
 * списка, поэтому новое событие сначала добавляется в automation, а уже потом здесь.
 */
export interface UsageEvent {
  name: string;
  occurredAt: string;
  props?: Record<string, string | number | boolean>;
}

type UsageDraft = Omit<UsageEvent, 'occurredAt'>;

const GATE_DECISIONS: Partial<Record<CoreCommand['type'], string>> = {
  'gate.approve': 'approve',
  'gate.reject': 'reject',
  'gate.answer': 'answer',
  'gate.fix': 'fix',
  'gate.accept': 'accept',
  'gate.cancel': 'cancel',
};

/** Команда, которую ядро успешно выполнило. */
export function usageFromCommand(cmd: CoreCommand): UsageDraft | null {
  if (cmd.type === 'run.start') return { name: 'run_started', props: cmd.input.mode ? { mode: cmd.input.mode } : {} };
  if (cmd.type === 'run.pr') return { name: 'pr_created' };
  const decision = GATE_DECISIONS[cmd.type];
  return decision ? { name: 'gate_decided', props: { decision } } : null;
}

export function usageFromCoreEvent(e: CoreEvent): UsageDraft | null {
  switch (e.type) {
    case 'gate.waiting':
      return { name: 'gate_waiting', props: { gate: e.gate } };
    case 'tests.result':
      return { name: 'tests_finished', props: { passed: e.result.passed, durationMs: Math.max(0, Math.round(e.result.durationMs)) } };
    case 'review.result':
      return { name: 'review_finished', props: { hasBlocking: e.result.blocking.length > 0 } };
    case 'stage.failed':
      return { name: 'stage_failed', props: { stage: e.stage } };
    case 'run.finished':
      return e.status === 'finished' || e.status === 'stopped' || e.status === 'cancelled'
        ? { name: 'run_finished', props: { status: e.status } }
        : null;
    default:
      return null;
  }
}

/** sent — принято; rejected — сервер отказал, повтор не поможет; failed — стоит повторить позже. */
export type UsageSendResult = 'sent' | 'rejected' | 'failed';

const BATCH_SIZE = 50;
const MAX_QUEUED = 500;

export class UsageQueue {
  private items: UsageEvent[] = [];
  private flushing: Promise<void> | null = null;

  constructor(private readonly send: (batch: UsageEvent[]) => Promise<UsageSendResult>) {}

  get size() {
    return this.items.length;
  }

  push(event: UsageEvent) {
    this.items.push(event);
    if (this.items.length > MAX_QUEUED) this.items.shift();
  }

  clear() {
    this.items = [];
  }

  /** Параллельный вызов присоединяется к идущей отправке: одно событие не уйдёт дважды. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drain() {
    while (this.items.length > 0) {
      const batch = this.items.slice(0, BATCH_SIZE);
      if ((await this.send(batch)) === 'failed') return;
      // Пока шла отправка, очередь могла быть очищена выключателем.
      this.items = this.items.filter((item) => !batch.includes(item));
    }
  }
}
