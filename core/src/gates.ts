// Гейты: остановка прогона в ожидании человека, решения человека и автопилот.
// Продолжение цикла — через k.engine.drive, чтобы гейты не зависели от движка.
import { c } from './agents/common.js';
import type { Kernel } from './kernel.js';
import { killGroup } from './proc.js';
import { acceptTarget } from './route.js';
import { stopPreview } from './services/preview.js';
import { getChangeDocs } from './services/runs.js';
import { STAGE_TITLES, isGate } from './stage-info.js';
import { mapFilesToPlan, summarizeChanges } from './stages/review.js';
import { traced } from './trace.js';
import type { Feedback, GateId, LineComment, RunFile } from './types.js';

/**
 * Решение автопилота с паузой, чтобы человек успел увидеть гейт. За паузу человек мог нажать «Стоп», принять сам или удалить прогон:
 * автопилот решает, только если прогон всё ещё ждёт на том же гейте.
 */
async function autoDecide(k: Kernel, id: string, gate: GateId, failure: string, comment?: string) {
  await new Promise((res) => setTimeout(res, 800));
  const r = k.store.load(id);
  if (!r || r.status !== 'waiting' || r.next !== gate) return;
  await decide(k, id, 'approve', comment).catch((e) => {
    const now = k.store.load(id);
    if (now) k.warn(now, `${failure}: ${(e as Error).message}`);
  });
}

export async function decide(
  k: Kernel,
  id: string,
  decision: 'approve' | 'reject' | 'cancel' | 'accept' | 'fix',
  comment?: string,
  lineComments?: LineComment[],
) {
  const r = k.mustLoad(id);
  if (!isGate(r.next) || (r.status !== 'waiting' && r.status !== 'stopped')) throw new Error('Прогон не ждёт решения на гейте');
  const gate = r.next as GateId;
  // Проверки — до любых действий: отклонённое решение не должно гасить сервер, с которым человек работает.
  if (decision === 'fix') {
    if (gate !== 'gate2') throw new Error('Быстрая правка — только на приёмке');
    if (!comment?.trim() && !lineComments?.length) throw new Error('Опишите, что поправить');
  }
  if (decision === 'accept' && gate !== 'limit') throw new Error('Принять как есть можно только после исчерпания попыток');
  // Решение принято — сервер ручной проверки гасим: дальше коммит или новая попытка в той же рабочей копии.
  await stopPreview(k, id);
  r.gates.push({
    gate,
    at: new Date().toISOString(),
    decision,
    comment: comment?.trim() || undefined,
    lineComments: lineComments?.length ? lineComments : undefined,
  });
  const gateAttempt = [...r.attempts].reverse().find((a) => a.stage === gate && a.status === 'running');
  if (gateAttempt) {
    gateAttempt.status = 'done';
    gateAttempt.endedAt = new Date().toISOString();
    gateAttempt.summary = decision === 'approve' ? 'Принято' : decision === 'reject' ? 'Возвращено' : 'Отменено';
  }
  r.message = undefined;
  const human = (text: string): Feedback => ({ source: 'human', text, lineComments: lineComments?.length ? lineComments : undefined });

  if (decision === 'fix') {
    if (gateAttempt) gateAttempt.summary = 'Быстрая правка';
    r.quickFix = true;
    r.next = 'implement';
    r.implAttemptsLimit = Math.max(r.implAttemptsLimit, r.implAttemptsUsed + 1);
    r.feedback = {
      source: 'human',
      text: `Человек на приёмке просит небольшую правку. Сделай ровно это и ничего больше — остальная реализация уже принята, не переделывай её:\n${comment ?? ''}`,
      lineComments: lineComments?.length ? lineComments : undefined,
    };
    k.log(r, c.violet('→ быстрая правка с приёмки: реализация → проверки → снова приёмка') + '\n');
    r.status = 'running';
    k.save(r);
    void k.engine.drive(r);
    return;
  }

  if (decision === 'accept') {
    // Человек берёт ответственность на себя: красные проверки или замечания ревью — дальше без новых попыток.
    // Визуальная проверка ещё не было — идём в неё (скриншоты пригодятся на приёмке), иначе — сразу на приёмку.
    const toVisual = acceptTarget(r) === 'visual';
    if (gateAttempt) gateAttempt.summary = toVisual ? 'Дальше как есть — к визуальной проверке' : 'Принято как есть';
    k.log(r, c.amber(`→ человек принял результат как есть — ${toVisual ? 'к визуальной проверке' : 'к приёмке'}`) + '\n');
    r.feedback = undefined;
    r.next = toVisual ? 'visual' : 'gate2';
    r.status = 'running';
    k.save(r);
    void k.engine.drive(r);
    return;
  }

  if (decision === 'cancel') {
    // Фоновые проверки эталона (идут, пока человек смотрит план) больше никому не нужны.
    k.basePrep.delete(id);
    await killGroup(id);
    if (gate === 'limit') {
      r.status = 'stopped';
      r.message = 'Остановлено после исчерпания попыток';
    } else {
      r.status = 'cancelled';
      r.finishedAt = new Date().toISOString();
    }
    k.save(r);
    k.emit({ type: 'run.finished', runId: id, status: r.status, message: r.message });
    return;
  }

  if (gate === 'gate0') {
    // «Принять» без ответов — продолжить по задаче как есть.
    if (r.clarify) r.clarify.skipped = true;
    r.next = 'plan';
  } else if (gate === 'gate1') {
    if (decision === 'approve') {
      r.next = 'implement';
      // План обновлён после возврата с реализации — исполнитель должен узнать, что и почему поменялось.
      r.feedback = r.replanNote
        ? human(
            `План обновлён: человек вернул задачу на план с реализации — «${r.replanNote}». Сверься с обновлённым proposal и tasks.md и продолжай по ним; то, что новому плану противоречит, переделай.`,
          )
        : undefined;
      r.replanNote = undefined;
      if (r.mode === 'epic') r.phase = 1;
    } else {
      r.next = 'plan';
      r.planRetries = 0;
      r.feedback = human(`Человек вернул план на доработку:\n${comment ?? ''}`);
    }
  } else if (gate === 'gate2') {
    if (decision === 'approve') {
      r.next = 'finish';
      r.feedback = undefined;
    } else {
      r.next = 'implement';
      r.implAttemptsLimit = Math.max(r.implAttemptsLimit, r.implAttemptsUsed + 1);
      r.feedback = human(`Человек вернул реализацию на приёмке:\n${comment ?? ''}`);
    }
  } else {
    // limit: «Ещё попытка» — даём одну попытку, сохраняя последнюю обратную связь.
    r.next = 'implement';
    r.implAttemptsLimit = r.implAttemptsUsed + 1;
    const prev = r.feedback?.text ?? '';
    r.feedback = {
      source: r.feedback?.source ?? 'human',
      text: [prev, comment?.trim() ? `Комментарий человека:\n${comment.trim()}` : ''].filter(Boolean).join('\n\n'),
      lineComments,
    };
  }
  r.status = 'running';
  k.save(r);
  void k.engine.drive(r);
}

export function gateMessage(k: Kernel, run: RunFile): string | undefined {
  if (run.next === 'gate0')
    return `У планировщика ${run.clarify?.questions.length ?? 0} ${(run.clarify?.questions.length ?? 0) === 1 ? 'вопрос' : 'вопроса'} по задаче — ответьте, чтобы план не строился на догадках.`;
  if (run.next === 'limit') return run.message ?? 'Попытки реализации исчерпаны. Дать ещё одну попытку?';
  if (run.next === 'gate1' && run.mode === 'bug') return 'Баг воспроизведён падающим тестом. Причина и план исправления верны?';
  if (run.next === 'gate1' && run.mode === 'epic') return 'Проверьте design.md, этапы в tasks.md и proposal. Принять дизайн?';
  if (run.next === 'gate1' && run.nextParts)
    return 'Задача большая — планировщик взял в этот план первую часть, остальные перечислены в разделе «Next Parts» в proposal. Запустите их следующими задачами после этой. Принять план первой части?';
  if (run.next === 'gate1') return 'Проверьте proposal и tasks. Принять, вернуть с комментарием или отменить?';
  if (run.next === 'gate2') return 'Посмотрите дифф и замечания ревью. Принять или вернуть на доработку?';
  return undefined;
}

export function waitGate(k: Kernel, run: RunFile, gate: GateId, message?: string) {
  const open = run.attempts.find((a) => a.stage === gate && a.status === 'running');
  if (!open) k.begin(run, gate);
  // Гейт сам по себе пауза: отложенная пауза здесь исполнена, после решения прогон пойдёт дальше.
  if (run.pending?.some((p) => p.kind === 'pause')) {
    const at = new Set(run.pending.filter((p) => p.kind === 'pause').map((p) => p.at));
    for (const i of run.interventions ?? []) if (at.has(i.at)) i.appliedAt ??= new Date().toISOString();
    run.pending = run.pending.filter((p) => p.kind !== 'pause');
    if (!run.pending.length) run.pending = undefined;
  }
  run.status = 'waiting';
  run.next = gate;
  run.message = message;
  k.save(run);
  k.log(run, c.amber(`◆ ${STAGE_TITLES[gate]}: ждём решения человека`) + '\n');
  k.emit({ type: 'gate.waiting', runId: run.id, gate, message });
  if (gate === 'gate2') {
    void summarizeChanges(k, run.id).catch(traced('summarizeChanges'));
    void mapFilesToPlan(k, run.id).catch(traced('mapFilesToPlan'));
  }
  if (run.autopilot) void autopilotGate(k, run, gate);
}

/**
 * Автопилот: план без вопросов к человеку принимается сам, при исчерпанных попытках — одна попытка сама.
 * Вопросы уточнения, разбивка задачи на части и приёмка — всегда за человеком.
 */
export async function autopilotGate(k: Kernel, run: RunFile, gate: GateId) {
  if (gate === 'gate1') {
    if (run.replanNote) {
      k.log(run, c.amber('Автопилот: план переписан после возврата с реализации — проверьте его сами.') + '\n');
      return;
    }
    const docs = await getChangeDocs(k, run.id).catch(() => null);
    if (docs && /^##\s+Next Parts/m.test(docs.proposal)) {
      k.log(run, c.amber('Автопилот: планировщик предлагает разбить задачу на части — план ждёт вашего решения.') + '\n');
      return;
    }
    k.log(run, c.violet('Автопилот: план принят без остановки.') + '\n');
    await autoDecide(k, run.id, gate, 'Автопилот не смог принять план — примите его сами', 'Автопилот');
    return;
  }
  if (gate === 'limit' && !run.autoRetried) {
    const r = k.mustLoad(run.id);
    r.autoRetried = true;
    k.save(r);
    k.log(run, c.violet('Автопилот: попытки исчерпаны — даю ещё одну сам; следующий раз решите вы.') + '\n');
    await autoDecide(k, run.id, gate, 'Автопилот не смог дать ещё одну попытку');
  }
}
