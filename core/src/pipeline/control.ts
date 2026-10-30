import { c } from '../agents/common.js';
import { Git } from '../git.js';
import { MODE_LIMIT, modeOf } from '../modes.js';
import { availableActions, replansLeft } from '../route.js';
import { isGate, STAGE_TITLES } from '../stages.js';
import type { ControlAction, RunFile } from '../types.js';
import type { Orchestrator } from '../orchestrator.js';

const ACTION_TITLE: Record<ControlAction['kind'], string> = {
  note: 'заметка агенту',
  pause: 'пауза',
  restart: 'переделать попытку',
  replan: 'вернуться к плану',
};

/**
 * Управление прогоном на ходу. Заметка и пауза ждут ближайшей контрольной точки (перед стадией),
 * «переделать» и «к плану» прерывают текущую стадию сразу — как «Пропустить проверки».
 */
export async function control(h: Orchestrator, id: string, action: ControlAction) {
  const before = h.mustLoad(id);
  if (!availableActions(before).includes(action.kind)) {
    if (action.kind === 'replan' && replansLeft(before) <= 0)
      throw new Error('Возвращаться к плану можно не больше двух раз за прогон — отмените задачу или начните новую');
    throw new Error(`Сейчас нельзя: ${ACTION_TITLE[action.kind]}`);
  }
  const text = 'text' in action ? action.text.trim() : '';
  if (action.kind !== 'pause' && !text) throw new Error('Опишите, что нужно');
  const now = new Date().toISOString();

  if (action.kind === 'note' || action.kind === 'pause') {
    before.pending = [
      ...(before.pending ?? []).filter((p) => !(p.kind === 'pause' && action.kind === 'pause')),
      { ...action, ...(text ? { text } : {}), at: now } as ControlAction & { at: string },
    ];
    before.interventions = [...(before.interventions ?? []), { at: now, kind: action.kind, text: text || undefined }];
    h.log(
      before,
      c.violet(
        action.kind === 'pause' ? '⏸ пауза перед следующей стадией' : `✎ заметка человека — уйдёт агенту при следующем запуске:\n${text}`,
      ) + '\n',
    );
    h.save(before);
    return;
  }

  await h.halt(id);
  const r = h.mustLoad(id);
  await h.stopPreview(id);
  const label = action.kind === 'replan' ? 'Возврат к плану' : 'Переделать попытку';
  for (const a of r.attempts) {
    if (a.status !== 'running') continue;
    Object.assign(a, isGate(a.stage) ? { status: 'done', summary: label } : { status: 'stopped' }, { endedAt: now });
  }
  r.message = undefined;
  r.mergeOnly = undefined;

  if (action.kind === 'restart') {
    r.next = 'implement';
    r.implAttemptsLimit = Math.max(r.implAttemptsLimit, r.implAttemptsUsed + 1);
    r.feedback = merge(
      r.feedback?.source === 'human' ? undefined : r.feedback,
      `Человек прервал попытку и просит переделать так:\n${text}`,
    );
    r.interventions = [...(r.interventions ?? []), { at: now, kind: 'restart', text, appliedAt: now }];
    h.log(r, c.violet(`↻ человек прервал попытку: переделать — ${text}`) + '\n');
  } else {
    await replan(h, r, text, action.keepCode !== false);
  }
  r.status = 'running';
  h.save(r);
  void h.drive(r);
}

/** Вернуться к плану: снимок работы, по желанию — откат кода, планировщику — что сделано и почему вернули. */
async function replan(h: Orchestrator, r: RunFile, reason: string, keepCode: boolean) {
  const now = new Date().toISOString();
  const tools = await h.tools(['git']);
  const git = new Git(tools.git, h.opts.env);
  const base = h.diffBase(r);
  const n = (r.interventions ?? []).filter((i) => i.kind === 'replan').length + 1;
  const ref = `refs/purpleflow/${r.id}/replan-${n}`;
  let snapshot: string | undefined;
  try {
    await git.snapshot(r.worktreePath, ref, `PurpleFlow: работа до возврата к плану №${n}`);
    snapshot = ref;
  } catch (e) {
    h.warn(r, `Не удалось сохранить снимок работы перед возвратом к плану: ${(e as Error).message}`);
  }
  // Файлы плана (openspec/) правит планировщик — их не откатываем.
  const code = (await git.changedFiles(r.worktreePath, base).catch(() => [] as string[])).filter(
    (f) => !f.startsWith('openspec/') && !h.envFilesOf(r).includes(f),
  );
  if (!keepCode && code.length) {
    if (!snapshot)
      throw new Error('Снимок работы не сохранился — откатывать код без него не буду. Попробуйте вернуться к плану с сохранением кода.');
    await git.restoreFromBase(r.worktreePath, base, code);
    r.executorSession = undefined;
  }
  const impl = [...r.attempts].reverse().find((a) => a.stage === 'implement' && (a.output || a.summary));
  r.feedback = {
    source: 'human',
    text: h.prompts.render('replan.md', {
      reason,
      files: code.length
        ? code
            .slice(0, 80)
            .map((f) => `- \`${f}\``)
            .join('\n')
        : '(код ещё не менялся)',
      code: !code.length
        ? ''
        : keepCode
          ? 'Код этих попыток остался в рабочей копии — исполнитель продолжит с него. Если что-то из сделанного больше не нужно, явно напиши об этом в tasks.md.'
          : `Код этих попыток откачен к исходному состоянию — исполнитель начнёт заново по новому плану (снимок сохранён в \`${ref}\`).`,
      report: (impl?.output ?? impl?.summary ?? '(исполнитель не оставил отчёта)').slice(0, 4000),
    }),
  };
  r.replanNote = reason;
  r.next = 'plan';
  r.planRetries = 0;
  // Новый план — новый запас попыток: иначе после принятия сразу «попытки исчерпаны».
  r.implAttemptsLimit = r.implAttemptsUsed + MODE_LIMIT[modeOf(r)];
  r.autoRetried = undefined;
  r.taskMap = undefined;
  r.changeSummary = undefined;
  r.interventions = [...(r.interventions ?? []), { at: now, kind: 'replan', text: reason, appliedAt: now, snapshot, keepCode }];
  h.log(r, c.violet(`↩ возврат к плану${keepCode ? '' : ' (код откачен)'}: ${reason}`) + '\n');
}

/**
 * Контрольная точка перед стадией. Пауза срабатывает перед любой стадией, заметки — только перед запуском
 * планировщика или исполнителя: проверки и ревью перезаписывают обратную связь, и заметка бы потерялась.
 * true — прогон поставлен на паузу.
 */
export function applyPending(h: Orchestrator, run: RunFile): boolean {
  const list = run.pending ?? [];
  if (!list.length) return false;
  const now = new Date().toISOString();
  const takesNotes = run.next === 'plan' || run.next === 'implement';
  const notes = takesNotes ? list.filter((p) => p.kind === 'note') : [];
  const pause = list.some((p) => p.kind === 'pause');
  const taken = new Set<object>([...notes, ...list.filter((p) => p.kind === 'pause')]);
  run.pending = list.filter((p) => !taken.has(p));
  if (!run.pending.length) run.pending = undefined;
  const applied = new Set(list.filter((p) => taken.has(p)).map((p) => p.at));
  for (const i of run.interventions ?? []) if (applied.has(i.at) && !i.appliedAt) i.appliedAt = now;
  if (notes.length) {
    run.feedback = merge(
      run.feedback,
      `Заметки человека, оставленные во время работы, — учти их:\n${notes.map((p) => `- ${'text' in p ? p.text : ''}`).join('\n')}`,
    );
    h.log(run, c.violet(`✎ заметки человека переданы: ${STAGE_TITLES[run.next]}`) + '\n');
  }
  h.save(run);
  if (pause) {
    h.markStopped(run, `Пауза по просьбе человека перед стадией «${STAGE_TITLES[run.next]}». «Продолжить» — с того же места.`);
    return true;
  }
  return false;
}

function merge(f: RunFile['feedback'], text: string): NonNullable<RunFile['feedback']> {
  if (!f) return { source: 'human', text };
  return { ...f, text: `${f.text}\n\n${text}` };
}
