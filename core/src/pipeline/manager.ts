import crypto from 'node:crypto';
import fs from 'node:fs';
import { Git } from '../git.js';
import { run as runProc } from '../proc.js';
import { modeOf } from '../modes.js';
import { availableActions, replansLeft } from '../route.js';
import { isGate, STAGE_TITLES } from '../shared.js';
import type { CommandAction, ControlAction, ManagerAction, ManagerMessage, RunFile } from '../types.js';
import type { Orchestrator } from '../orchestrator.js';

/** Сколько последних сообщений переписки менеджер видит. */
const HISTORY = 20;

const STATUS: Record<RunFile['status'], string> = {
  queued: 'в очереди', running: 'идёт', waiting: 'ждёт решения человека', stopped: 'остановлен', cancelled: 'отменён', finished: 'завершён',
};

const ACTIONS: Record<ManagerAction['kind'], string> = {
  command: '`command` — выполнить команду оболочки (git tag, git push, скрипт проекта…) после подтверждения человеком; поля: command — ровно команда, text — что она сделает, cwd — "project" (папка проекта, основная рабочая копия) или "worktree" (рабочая копия прогона)',
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
      actions: [...availableActions(run), 'command' as const].map((k) => `- ${ACTIONS[k]}`).join('\n'),
      project: run.projectPath,
      worktree: hasWorktree(run) ? run.worktreePath : '(нет — удалена или ещё не создана)',
      chat: messages.slice(-HISTORY).map((m) => `${m.role === 'user' ? 'Человек' : 'Менеджер'}: ${m.text}${m.action ? `\n(предложено: ${describe(m.action)} — ${m.actionState === 'applied' ? 'применено' : m.actionState === 'dismissed' ? 'отклонено' : 'ждёт'})` : ''}${m.result ? `\n(результат: код ${m.result.code ?? '—'}\n${tail(m.result.output, 1500)})` : ''}`).join('\n\n'),
    });
    // Только чтение: файлы проекта и прогона. Всё, что меняет состояние, — через предложенное действие и кнопку человека.
    const cwd = hasWorktree(run) ? run.worktreePath : run.projectPath;
    const res = await h.service({ prompt, group: `${id}:manager`, timeoutMs: 5 * 60_000, model: s.models.manager || undefined, cwd, addDirs: [run.projectPath], tools: ['Read', 'Grep', 'Glob'] });
    if (!res.ok) throw new Error(res.error ?? 'Менеджер не ответил');
    const parsed = parseReply(res.text);
    // Ход прогона мог уйти вперёд, пока менеджер думал: предлагаем только то, что доступно сейчас.
    const fresh = h.mustLoad(id);
    const allowed = availableActions(fresh);
    let action = parsed.action && (parsed.action.kind === 'command' || allowed.includes(parsed.action.kind)) ? parsed.action : undefined;
    if (action?.kind === 'command' && action.cwd === 'worktree' && !hasWorktree(fresh)) action = { ...action, cwd: 'project' };
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
  const action = m.action;
  if (apply && action.kind === 'command') return runCommand(h, id, messages, m, action);
  if (apply && action.kind !== 'command') await h.control(id, action);
  m.actionState = apply ? 'applied' : 'dismissed';
  publish(h, id, messages);
  return messages;
}

const hasWorktree = (r: RunFile) => !r.workspacePending && !r.worktreeRemoved && fs.existsSync(r.worktreePath);

/** Команда, подтверждённая человеком: выполняется в папке проекта или прогона, вывод — отдельным сообщением. */
async function runCommand(h: Orchestrator, id: string, messages: ManagerMessage[], m: ManagerMessage, a: CommandAction): Promise<ManagerMessage[]> {
  if (h.managerBusy.has(id)) throw new Error('Менеджер ещё занят — дождитесь ответа');
  const run = h.mustLoad(id);
  const cwd = a.cwd === 'worktree' && hasWorktree(run) ? run.worktreePath : run.projectPath;
  m.actionState = 'applied';
  h.managerBusy.add(id);
  publish(h, id, messages);
  let output = '';
  const take = (t: string) => { output = (output + t).slice(-20_000); };
  try {
    const r = await runProc(a.command, [], { cwd, env: h.opts.env, shell: true, group: `${id}:manager`, timeoutMs: 5 * 60_000, onStdout: take, onStderr: take });
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const why = r.spawnError ?? (r.timedOut ? 'не уложилась в 5 минут' : '');
    messages.push({
      id: crypto.randomUUID(), at: new Date().toISOString(), role: 'manager',
      text: r.code === 0 ? 'Готово.' : `Команда завершилась ${why || `с кодом ${r.code}`}.`,
      error: r.code !== 0 || undefined,
      result: { code: r.code, output: tail(clean, 6000) },
    });
  } finally {
    h.managerBusy.delete(id);
  }
  publish(h, id, messages);
  return messages;
}

function describe(a: ManagerAction): string {
  switch (a.kind) {
    case 'command': return `команда \`${a.command}\` (${a.cwd === 'worktree' ? 'в рабочей копии прогона' : 'в папке проекта'})`;
    case 'note': return `заметка «${a.text}»`;
    case 'pause': return 'пауза';
    case 'restart': return `переделать попытку: ${a.text}`;
    case 'replan': return `вернуться к плану${a.keepCode === false ? ' с откатом кода' : ''}: ${a.text}`;
  }
}

/** JSON-объект из ответа модели: весь ответ, блок ```json или от первой { до последней }. Блоки кода внутри reply не мешают. */
function jsonOf(raw: string): { reply?: unknown; action?: Record<string, unknown> | null } | null {
  const fenced = raw.match(/^```(?:json)?\s*\n([\s\S]*)\n```\s*$/)?.[1];
  for (const cand of [raw, fenced, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    if (!cand?.trim().startsWith('{')) continue;
    try {
      const o = JSON.parse(cand) as unknown;
      if (o && typeof o === 'object' && 'reply' in o) return o as { reply?: unknown; action?: Record<string, unknown> | null };
    } catch { /* следующий вариант */ }
  }
  return null;
}

/** Ответ модели — JSON {reply, action}; если модель ответила текстом — это просто ответ без действия. */
export function parseReply(text: string): { reply: string; action?: ManagerAction } {
  const raw = text.trim();
  const o = jsonOf(raw);
  if (!o) return { reply: raw };
  const reply = typeof o.reply === 'string' ? o.reply.trim() : '';
  const a = o.action;
  const t = typeof a?.text === 'string' ? a.text.trim() : '';
  let action: ManagerAction | undefined;
  const cmd = typeof a?.command === 'string' ? a.command.trim() : '';
  if (a?.kind === 'command' && cmd) action = { kind: 'command', command: cmd, text: t || cmd, cwd: a.cwd === 'worktree' ? 'worktree' : 'project' };
  else if (a?.kind === 'pause') action = { kind: 'pause' };
  else if ((a?.kind === 'note' || a?.kind === 'restart') && t) action = { kind: a.kind, text: t };
  else if (a?.kind === 'replan' && t) action = { kind: 'replan', text: t, keepCode: a.keepCode !== false };
  return { reply, action };
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

  if (tools) out.push(await gitFacts(h, run, tools.git));

  const impl = [...run.attempts].reverse().find((a) => a.stage === 'implement' && a.output);
  if (impl?.output) out.push(`\n## Последний отчёт исполнителя\n${clip(impl.output, 2500)}`);
  if (run.interventions?.length) out.push(`\n## Вмешательства человека\n${run.interventions.slice(-10).map((i) => `- ${i.kind}${i.text ? `: ${clip(i.text, 300)}` : ''}${i.appliedAt ? '' : ' (ещё не применено)'}`).join('\n')}`);
  if (run.warnings?.length) out.push(`\n## Предупреждения\n${run.warnings.slice(-5).map((w) => `- ${w.text}`).join('\n')}`);

  const log = h.store.readLog(run.id, 64 * 1024).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  if (log.trim()) out.push(`\n## Хвост лога агентов\n${tail(log, 6000)}`);
  return out.join('\n');
}

/** Git проекта для вопросов о ветках, тегах и релизах — менеджер сам git не запускает. */
async function gitFacts(h: Orchestrator, run: RunFile, bin: string): Promise<string> {
  const g = (args: string[]) => runProc(bin, args, { cwd: run.projectPath, env: h.opts.env, timeoutMs: 15_000 }).then((r) => (r.code === 0 ? r.stdout.trim() : '')).catch(() => '');
  const [status, tags, log] = await Promise.all([
    g(['status', '-sb', '--porcelain=v1']),
    g(['tag', '--sort=-creatordate', '--format=%(refname:short) (%(creatordate:short))']),
    g(['log', '--oneline', '-8']),
  ]);
  const lines = [`\n## Git проекта (${run.projectPath})`, `Ветка и отставание: ${status.split('\n')[0]?.replace(/^## /, '') || '—'}`];
  lines.push(`Ветка прогона: ${run.branch}${run.merged ? `, влита в ${run.merged.into} (${run.merged.commit.slice(0, 8)})` : ''}${run.pr ? `, PR #${run.pr.number} в ${run.pr.base}` : ''}`);
  lines.push(`Последние теги (новые — выше):\n${tags.split('\n').filter(Boolean).slice(0, 8).map((t) => `- ${t}`).join('\n') || '(тегов нет)'}`);
  lines.push(`Последние коммиты текущей ветки:\n${log || '—'}`);
  return lines.join('\n');
}
