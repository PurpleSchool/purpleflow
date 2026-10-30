import type { RunFile, RunMode, StageId } from './types.js';

/** Стадии режима по порядку (гейты — решения человека). */
export function stagesOf(mode: RunMode, visual: boolean): StageId[] {
  const v: StageId[] = visual ? ['visual'] : [];
  switch (mode) {
    case 'quick':
      return ['implement', 'tests', 'review', ...v, 'gate2', 'finish'];
    case 'refactor':
      return ['baseline', 'clarify', 'plan', 'gate1', 'implement', 'tests', 'review', ...v, 'gate2', 'finish'];
    default:
      return ['clarify', 'plan', 'gate1', 'implement', 'tests', 'review', ...v, 'gate2', 'finish'];
  }
}

export const modeOf = (run: Pick<RunFile, 'mode'>): RunMode => run.mode ?? 'task';

export const MODE_FIRST: Record<RunMode, StageId> = {
  quick: 'implement',
  bug: 'clarify',
  task: 'clarify',
  epic: 'clarify',
  refactor: 'baseline',
};

/** Лимит попыток реализации (для большой задачи — на этап). */
export const MODE_LIMIT: Record<RunMode, number> = { quick: 2, bug: 3, task: 3, epic: 3, refactor: 3 };

/** Быстрая правка без ревью, если дифф маленький. */
export const QUICK_REVIEW_LINES = 120;

/** Файлы тестов: в рефакторинге их менять нельзя. */
export const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
