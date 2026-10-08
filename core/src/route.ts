/**
 * Маршрут прогона — одна правда для ядра и окна: какая стадия дальше, что пропускается,
 * где показывать «попытки исчерпаны», куда ведёт «Дальше как есть».
 * Чистые функции без Node: окно импортирует этот файл напрямую (`@psflow/route`).
 */
import { modeOf, stagesOf } from './modes.js';
import type { RunFile, StageId } from './types.js';

export { stagesOf } from './modes.js';

type RouteRun = Pick<RunFile, 'mode' | 'visual' | 'quickFix' | 'mergeOnly' | 'roundFiles' | 'phase' | 'phases' | 'attempts' | 'status' | 'next'>;

/** Какой это круг: обычный, быстрая правка с приёмки, слияние базовой ветки, разрешение конфликтов. */
export type RoundKind = 'normal' | 'quickFix' | 'merge' | 'conflicts';

export function roundOf(run: Pick<RunFile, 'quickFix' | 'mergeOnly' | 'roundFiles'>): RoundKind {
  if (run.mergeOnly) return 'merge';
  if (run.roundFiles?.length) return 'conflicts';
  if (run.quickFix) return 'quickFix';
  return 'normal';
}

/** Большая задача, и после этого этапа есть следующий. */
export const epicHasMore = (run: Pick<RunFile, 'mode' | 'phase' | 'phases'>) =>
  modeOf(run) === 'epic' && Boolean(run.phases) && (run.phase ?? 1) < (run.phases ?? 1);

/** Стадии, которые в этом круге пропускаются. */
export function skippedStages(run: Pick<RunFile, 'visual' | 'quickFix' | 'mergeOnly' | 'roundFiles'>): Set<StageId> {
  const skip = new Set<StageId>();
  if (!run.visual) skip.add('visual');
  const round = roundOf(run);
  if (round !== 'normal') { skip.add('review'); skip.add('visual'); }
  if (round === 'merge') skip.add('gate2');
  return skip;
}

/**
 * Куда после зелёных проверок. needsReview — решение по размеру диффа для быстрой правки
 * (его считает ядро, окну оно не нужно).
 */
export function afterChecks(run: RouteRun, needsReview = true): StageId {
  const round = roundOf(run);
  if (round === 'merge') return 'finish';
  if (round !== 'normal') return 'gate2';
  if (!needsReview) return run.visual ? 'visual' : 'gate2';
  return 'review';
}

/** Ревью без блокирующих — дальше визуальная проверка (если включена) или приёмка. */
export const afterReview = (run: Pick<RunFile, 'visual'>): StageId => (run.visual ? 'visual' : 'gate2');

/** Ревью можно запускать одновременно с проверками: обычный круг, не промежуточный этап большой задачи. */
export const reviewInParallel = (run: RouteRun, needsReview = true) =>
  roundOf(run) === 'normal' && !epicHasMore(run) && afterChecks(run, needsReview) === 'review';

/**
 * Строка ганта для «попытки исчерпаны»: стадия, которая не пропустила дальше. Проверки и ревью могут идти
 * параллельно — берём упавшую после последней реализации (ревью важнее). upTo — индекс попытки limit.
 */
export function limitRow(run: Pick<RunFile, 'attempts'>, upTo = run.attempts.length): StageId {
  let first: StageId | null = null;
  let failed: StageId | null = null;
  for (let i = upTo - 1; i >= 0; i--) {
    const a = run.attempts[i];
    if (a.stage === 'gate2' || a.stage === 'limit') { if (first) break; continue; }
    if (a.stage === 'review' || a.stage === 'tests' || a.stage === 'visual' || a.stage === 'implement') {
      first ??= a.stage;
      if (a.status === 'failed' && (!failed || a.stage === 'review')) failed = a.stage;
      if (a.stage === 'implement') break;
    }
  }
  return failed ?? first ?? 'gate2';
}

/** Куда «Дальше как есть» с гейта исчерпанных попыток: визуальная проверка, если не она сама не пропустила. */
export function acceptTarget(run: Pick<RunFile, 'attempts' | 'visual'>): 'visual' | 'gate2' {
  if (!run.visual) return 'gate2';
  for (let i = run.attempts.length - 1; i >= 0; i--) {
    const s = run.attempts[i].stage;
    if (s === 'visual') return 'gate2';
    if (s === 'review' || s === 'tests' || s === 'implement') return 'visual';
  }
  return 'gate2';
}

/** Строка, в которой сейчас прогон: «limit» — у стадии, что не пропустила, ответы на вопросы — у уточнения. */
export const currentRow = (run: Pick<RunFile, 'attempts' | 'next'>): StageId =>
  run.next === 'limit' ? limitRow(run) : run.next === 'gate0' ? 'clarify' : run.next;

/** Стадии после текущей: 'planned' — пройдёт, 'skip' — пропустится в этом круге. */
export function plannedRoute(run: RouteRun): Partial<Record<StageId, 'planned' | 'skip'>> {
  if (run.status === 'finished' || run.status === 'cancelled') return {};
  const ids = stagesOf(modeOf(run), Boolean(run.visual));
  const from = ids.indexOf(currentRow(run));
  if (from < 0) return {};
  const skip = skippedStages(run);
  const out: Partial<Record<StageId, 'planned' | 'skip'>> = {};
  for (const id of ids.slice(from + 1)) out[id] = skip.has(id) ? 'skip' : 'planned';
  return out;
}
