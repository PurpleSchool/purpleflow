import crypto from 'node:crypto';
import { Git } from '../git.js';
import { modeOf } from '../modes.js';
import { availableActions, replansLeft } from '../route.js';
import { isGate, STAGE_TITLES } from '../shared.js';
import type { ControlAction, ManagerMessage, RunFile } from '../types.js';
import type { Orchestrator } from '../orchestrator.js';

/** Сколько последних сообщений переписки менеджер видит. */
const HISTORY = 20;

const STATUS: Record<RunFile['status'], string> = {
  queued: 'в очереди', running: 'идёт', waiting: 'ждёт решения человека', stopped: 'остановлен', cancelled: 'отменён', finished: 'завершён',
};

const ACTIONS: Record<ControlAction['kind'], string> = {
  note: '`note` — заметка: уйдёт планировщику или исполнителю при следующем запуске, текущую стадию не прерывает',
  pause: '`pause` — пауза перед следующей стадией (текущая доработает)',
  restart: '`restart` — прервать реализацию сейчас и сделать попытку заново с указанием, что поменять',
  replan: '`replan` — прервать и вернуться к плану; keepCode: true — сделанный код остаётся (по умолчанию), false — откатить',
};

export function getManagerChat(h: Orchestrator, id: string): ManagerMessage[] {
  return h.store.readChat(id);
}

function publish(h: Orchestrator, id: string, messages: ManagerMessage[]) {
  h.store.writeChat(id, messages);
  h.emit({ type: 'manager.updated', runId: id, messages, thinking: h.managerBusy.has(id) });
}

/** Вопрос или просьба человека: менеджер отвечает по фактам прогона и, если нужно, предлагает действие. */
export async function askManager(h: Orchestrator, id: string, text: string): Promise<ManagerMessage[]> {
  const run = h.mustLoad(id);
  if (!text.trim()) throw new Error('Пустое сообщение');
  if (h.managerBusy.has(id)) throw new Error('Менеджер ещё отвечает на прошлое сообщение');
  const msg = (role: ManagerMessage['role'], t: string, extra: Partial<ManagerMessage> = {}): ManagerMessage =>
    ({ id: crypto.randomUUID(), at: new Date().toISOString(), role, text: t, ...extra });
  const history = h.store.readChat(id);
  // Новое сообщение отменяет непринятые предложения: менеджер предложит заново, если нужно.
  for (const m of history) if (m.actionState === 'proposed') m.actionState = 'dismissed';
  const messages = [...history, msg('user', text.trim())];
  h.managerBusy.add(id);
  publish(h, id, messages);
  try {
    const s = h.opts.getSettings();
    const prompt = h.prompts.render('manager.md', {
      state: await managerSnapshot(h, run),
      actions: availableActions(run).map((k) => `- ${ACTIONS[k]}`).join('\n') || '- (сейчас никаких: прогон завершён)',
      chat: messages.slice(-HISTORY).map((m) => `${m.role === 'user' ? 'Человек' : 'Менеджер'}: ${m.text}${m.action ? `\n(предложено: ${describe(m.action)} — ${m.actionState === 'applied' ? 'применено' : m.actionState === 'dismissed' ? 'отклонено' : 'ждёт'})` : ''}`).join('\n\n'),
    });
    const res = await h.service({ prompt, group: `${id}:manager`, timeoutMs: 3 * 60_000, model: s.models.manager || undefined });
    if (!res.ok) throw new Error(res.error ?? 'Менеджер не ответил');
    const parsed = parseReply(res.text);
    // Ход прогона мог уйти вперёд, пока менеджер думал: предлагаем только то, что доступно сейчас.
    const allowed = availableActions(h.mustLoad(id));
    const action = parsed.action && allowed.includes(parsed.action.kind) ? parsed.action : undefined;
    messages.push(msg('manager', parsed.reply || 'Не понял вопрос — переформулируйте, пожалуйста.', action ? { action, actionState: 'proposed' } : {}));
  } catch (e) {
    messages.push(msg('manager', `Не получилось ответить: ${(e as Error).message}`, { error: true }));
  } finally {
    h.managerBusy.delete(id);
  }
  publish(h, id, messages);
  return messages;
}

/** Человек принял или отклонил предложение менеджера. */
export async function resolveManagerAction(h: Orchestrator, id: string, messageId: string, apply: boolean): Promise<ManagerMessage[]> {
  const messages = h.store.readChat(id);
  const m = messages.find((x) => x.id === messageId);
  if (!m?.action || m.actionState !== 'proposed') throw new Error('Это предложение уже неактуально');
  if (apply) await h.control(id, m.action);
  m.actionState = apply ? 'applied' : 'dismissed';
  publish(h, id, messages);
  return messages;
}

function describe(a: ControlAction): string {
  switch (a.kind) {
    case 'note': return `заметка «${a.text}»`;
    case 'pause': return 'пауза';
    case 'restart': return `переделать попытку: ${a.text}`;
    case 'replan': return `вернуться к плану${a.keepCode === false ? ' с откатом кода' : ''}: ${a.text}`;
  }
}

/** Ответ модели — JSON {reply, action}; если модель ответила текстом — это просто ответ без действия. */
export function parseReply(text: string): { reply: string; action?: ControlAction } {
  const raw = text.trim();
  const json = raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try {
    const o = JSON.parse(json) as { reply?: unknown; action?: Record<string, unknown> | null };
    const reply = typeof o.reply === 'string' ? o.reply.trim() : '';
    const a = o.action;
    const t = typeof a?.text === 'string' ? a.text.trim() : '';
    let action: ControlAction | undefined;
    if (a?.kind === 'pause') action = { kind: 'pause' };
    else if ((a?.kind === 'note' || a?.kind === 'restart') && t) action = { kind: a.kind, text: t };
    else if (a?.kind === 'replan' && t) action = { kind: 'replan', text: t, keepCode: a.keepCode !== false };
    return { reply, action };
  } catch {
    return { reply: raw };
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (обрезано)` : s);
const tail = (s: string, n: number) => (s.length > n ? `… (начало обрезано)\n${s.slice(-n)}` : s);
const mins = (from: string, to?: string) => {
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} с` : `${Math.round(ms / 60_000)} мин`;
};

/** Факты о прогоне для менеджера: структурированно, с ограничением объёма — не пересказ сырого лога. */
export async function managerSnapshot(h: Orchestrator, run: RunFile): Promise<string> {
  const out: string[] = [];
  out.push(`Задача: ${clip(h.taskText(run), 3000)}`);
  out.push(`Режим: ${modeOf(run)}${run.autopilot ? ', автопилот' : ''}. Статус: ${STATUS[run.status]}. Сейчас: ${STAGE_TITLES[run.next]}.${run.message ? ` Сообщение: ${run.message}` : ''}`);
  out.push(`Попытки реализации: ${run.implAttemptsUsed} из ${run.implAttemptsLimit}. Возвратов к плану осталось: ${replansLeft(run)}.`);

  const stages = run.attempts.filter((a) => !isGate(a.stage) || a.status !== 'running').slice(-25);
  out.push(`\n## Ход прогона (старые — выше)\n${stages.map((a) => `- ${STAGE_TITLES[a.stage]} №${a.attempt}: ${a.status}, ${mins(a.startedAt, a.endedAt)}${a.summary ? ` — ${a.summary}` : ''}${a.error ? ` (ошибка: ${clip(a.error, 300)})` : ''}`).join('\n')}`);

  const docs = modeOf(run) === 'quick' ? null : await h.getChangeDocs(run.id).catch(() => null);
  if (docs?.tasks.trim()) out.push(`\n## План (tasks.md, [x] — сделано)\n${clip(docs.tasks, 6000)}`);

  const test = run.tests.at(-1);
  if (test) {
    const failed = (test.checks ?? []).filter((x) => !x.passed && !x.preexisting && !x.unstable);
    out.push(`\n## Последние проверки: ${test.passed ? 'зелёные' : 'красные'}${failed.length ? `\n${failed.map((x) => `- ${x.kind} \`${x.command}\`:\n${tail(x.output, 1500)}`).join('\n')}` : ''}`);
  }
  const review = run.reviews.at(-1);
  if (review) out.push(`\n## Последнее ревью: блокирующих ${review.blocking.length}, заметок ${review.notes.length}${review.blocking.length ? `\n${review.blocking.slice(0, 10).map((i) => `- ${i.file ?? ''}${i.line ? `:${i.line}` : ''} ${clip(i.message, 400)}`).join('\n')}` : ''}`);

  const tools = await h.tools(['git']).catch(() => null);
  if (tools && !run.workspacePending && !run.worktreeRemoved) {
    const files = await new Git(tools.git, h.opts.env).changedFiles(run.worktreePath, h.diffBase(run)).catch(() => [] as string[]);
    const code = files.filter((f) => !f.startsWith('openspec/'));
    out.push(`\n## Изменённые файлы (${code.length})\n${code.slice(0, 80).map((f) => `- ${f}`).join('\n') || '(пока нет)'}`);
  }

  const impl = [...run.attempts].reverse().find((a) => a.stage === 'implement' && a.output);
  if (impl?.output) out.push(`\n## Последний отчёт исполнителя\n${clip(impl.output, 2500)}`);
  if (run.interventions?.length) out.push(`\n## Вмешательства человека\n${run.interventions.slice(-10).map((i) => `- ${i.kind}${i.text ? `: ${clip(i.text, 300)}` : ''}${i.appliedAt ? '' : ' (ещё не применено)'}`).join('\n')}`);
  if (run.warnings?.length) out.push(`\n## Предупреждения\n${run.warnings.slice(-5).map((w) => `- ${w.text}`).join('\n')}`);

  const log = h.store.readLog(run.id, 64 * 1024).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  if (log.trim()) out.push(`\n## Хвост лога агентов\n${tail(log, 6000)}`);
  return out.join('\n');
}
