import type { RunFile, StageAttempt, StageId } from '@psflow/core';

export interface StageDef {
  id: StageId;
  title: string;
  actor: 'claude' | 'codex' | 'человек' | 'оркестратор';
  role?: 'planner' | 'executor' | 'reviewer';
  gate?: boolean;
  hint: string;
}

export type Mode = 'quick' | 'bug' | 'task' | 'epic' | 'refactor';

export interface ModeDef {
  id: Mode;
  title: string;
  hint: string;
}

export const MODES: ModeDef[] = [
  { id: 'quick', title: 'Быстрая правка', hint: 'Опечатка, конфиг, мелочь в 1–2 файлах. Без плана; ревью — только если дифф большой' },
  { id: 'bug', title: 'Баг', hint: 'Сначала падающий тест, который воспроизводит ошибку, потом исправление' },
  { id: 'task', title: 'Задача', hint: 'Обычная фича: план OpenSpec, реализация, проверки, ревью' },
  { id: 'epic', title: 'Большая задача', hint: 'Дизайн с вариантами, реализация по этапам с проверками после каждого' },
  { id: 'refactor', title: 'Рефакторинг', hint: 'Без изменения поведения: проверки зелёные до и после, тесты не трогаем' },
];

const BASE: Record<StageId, StageDef> = {
  baseline: { id: 'baseline', title: 'Базовые проверки', actor: 'оркестратор', hint: 'Линтер и тесты зелёные до начала — эталон поведения' },
  clarify: { id: 'clarify', title: 'Уточнение', actor: 'claude', role: 'planner', hint: 'Вопросы по задаче, если она неоднозначна — иначе сразу к плану' },
  gate0: { id: 'gate0', title: 'Ответы на вопросы', actor: 'человек', gate: true, hint: '' },
  plan: { id: 'plan', title: 'План', actor: 'claude', role: 'planner', hint: 'Изменение OpenSpec: proposal, tasks, дельты спецификаций' },
  gate1: { id: 'gate1', title: 'Утверждение плана', actor: 'человек', gate: true, hint: 'Принять, вернуть с комментарием или отменить' },
  implement: { id: 'implement', title: 'Реализация', actor: 'claude', role: 'executor', hint: 'Выполняет tasks.md на ветке прогона' },
  tests: { id: 'tests', title: 'Проверки', actor: 'оркестратор', hint: 'Линтер и тесты проекта' },
  visual: { id: 'visual', title: 'Визуальная проверка', actor: 'claude', role: 'executor', hint: 'Запускает приложение, проходит сценарии в браузере, снимает скриншоты' },
  review: { id: 'review', title: 'Ревью', actor: 'codex', role: 'reviewer', hint: 'Другая модель сверяет дифф с планом' },
  gate2: { id: 'gate2', title: 'Приёмка', actor: 'человек', gate: true, hint: 'Дифф, замечания ревью и ваши замечания' },
  limit: { id: 'limit', title: 'Нужно решение', actor: 'человек', gate: true, hint: '' },
  finish: { id: 'finish', title: 'Архив и коммит', actor: 'оркестратор', hint: 'openspec archive и коммит в ветку psflow/…' },
};

const OVERRIDE: Partial<Record<Mode, Partial<Record<StageId, Partial<StageDef>>>>> = {
  quick: {
    implement: { hint: 'Правка прямо по тексту задачи, без плана' },
    review: { hint: 'Только если дифф больше 120 строк' },
    finish: { title: 'Коммит', hint: 'Коммит в ветку psflow/…' },
  },
  bug: {
    plan: { title: 'Воспроизведение', hint: 'Причина бага и падающий тест; проверки должны быть красными' },
    gate1: { title: 'Подтверждение причины', hint: 'Причина и план исправления верны?' },
    implement: { title: 'Исправление', hint: 'Минимальный фикс — тест воспроизведения становится зелёным' },
  },
  epic: {
    plan: { title: 'Дизайн и план', hint: 'design.md с вариантами, tasks.md по этапам' },
    gate1: { title: 'Утверждение дизайна', hint: 'Подход, этапы и риски' },
    implement: { title: 'Реализация по этапам', hint: 'Этап за этапом, проверки после каждого' },
  },
  refactor: {
    plan: { hint: 'Структурные изменения без дельт спецификаций' },
    implement: { hint: 'Маленькие шаги, тесты не трогаем' },
  },
};

/** Стадии режима по порядку — как в ядре (core/src/modes.ts). */
export function stagesFor(mode: Mode = 'task', visual = false): StageDef[] {
  const v: StageId[] = visual ? ['visual'] : [];
  const ids: StageId[] =
    mode === 'quick' ? ['implement', 'tests', 'review', ...v, 'gate2', 'finish']
    : mode === 'refactor' ? ['baseline', 'clarify', 'plan', 'gate1', 'implement', 'tests', 'review', ...v, 'gate2', 'finish']
    : ['clarify', 'plan', 'gate1', 'implement', 'tests', 'review', ...v, 'gate2', 'finish'];
  return ids.map((id) => ({ ...BASE[id], ...OVERRIDE[mode]?.[id] }));
}

/** Стадии прогона. У прогонов до появления «Уточнения» этой строки нет — не показываем пустую. */
export const runStages = (run: Pick<RunFile, 'mode' | 'visual'> & { attempts?: RunFile['attempts'] }) => {
  const all = stagesFor((run.mode ?? 'task') as Mode, Boolean(run.visual));
  const old = run.attempts?.length && !run.attempts.some((a) => a.stage === 'clarify');
  return old ? all.filter((s) => s.id !== 'clarify') : all;
};

/** Стадии обычной задачи — для мест, где режим не важен. */
export const STAGES: StageDef[] = stagesFor('task');

export const stageTitle = (run: Pick<RunFile, 'mode' | 'visual'>, id: StageId) =>
  runStages(run).find((s) => s.id === id)?.title ?? BASE[id]?.title ?? id;

export type NodeState = 'idle' | 'active' | 'waiting' | 'done' | 'failed' | 'stopped' | 'stale';

/**
 * Строка ганта для «попытки исчерпаны»: стадия, которая не пропустила дальше (ревью, проверки, реализация),
 * — там и решение человека. upTo — индекс попытки limit в run.attempts (по умолчанию — текущая).
 */
export function limitRow(run: Pick<RunFile, 'attempts'>, upTo = run.attempts.length): StageId {
  // Проверки и ревью могут идти параллельно: берём ту из стадий после последней реализации, что упала (ревью — приоритетнее).
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

/** Куда «Дальше как есть» с гейта исчерпанных попыток (как acceptTarget в ядре). */
export function acceptTarget(run: Pick<RunFile, 'attempts' | 'visual'>): 'visual' | 'gate2' {
  if (!run.visual) return 'gate2';
  for (let i = run.attempts.length - 1; i >= 0; i--) {
    const s = run.attempts[i].stage;
    if (s === 'visual') return 'gate2';
    if (s === 'review' || s === 'tests' || s === 'implement') return 'visual';
  }
  return 'gate2';
}

function order(run: RunFile, id: StageId): number {
  const ids = runStages(run).map((s) => s.id);
  return id === 'limit' ? ids.indexOf(limitRow(run)) + 0.5 : id === 'gate0' ? ids.indexOf('clarify') + 0.5 : ids.indexOf(id);
}

export function lastAttempt(run: RunFile, stage: StageId): StageAttempt | undefined {
  for (let i = run.attempts.length - 1; i >= 0; i--) if (run.attempts[i].stage === stage) return run.attempts[i];
  return undefined;
}

export function nodeState(run: RunFile, stage: StageId): NodeState {
  const a = lastAttempt(run, stage);
  if (run.status === 'finished') return 'done';
  const cur = order(run, run.next);
  const me = order(run, stage);
  // «Попытки исчерпаны» рисуется в строке стадии, которая не пропустила дальше, — там и показываем, что ждём человека.
  const nextRow = run.next === 'limit' ? limitRow(run) : run.next === 'gate0' ? 'clarify' : run.next;
  if (stage === nextRow) {
    if (run.status === 'waiting') return 'waiting';
    if (run.status === 'running') return 'active';
    if (a?.status === 'failed') return 'failed';
    if (run.status === 'stopped' || run.status === 'cancelled') return 'stopped';
  }
  if (!a) return 'idle';
  // Ревью идёт параллельно с проверками: строка «впереди», но стадия уже работает.
  if (a.status === 'running' && run.status === 'running') return 'active';
  if (me > cur) return 'stale';
  if (a.status === 'failed') return me < cur ? 'done' : 'failed';
  if (a.status === 'stopped') return 'stopped';
  return 'done';
}

/**
 * Куда прогон пойдёт дальше: стадии после текущей строки — 'planned' (пройдёт) или 'skip' (пропустится).
 * Повторяет маршрут ядра: быстрая правка и разрешение конфликтов — без ревью и визуальной проверки,
 * слияние базовой ветки без конфликтов — сразу в PR.
 */
export function plannedRoute(run: RunFile): Partial<Record<StageId, 'planned' | 'skip'>> {
  if (run.status === 'finished' || run.status === 'cancelled') return {};
  const ids = runStages(run).map((s) => s.id);
  const cur = run.next === 'limit' ? limitRow(run) : run.next === 'gate0' ? 'clarify' : run.next;
  const from = ids.indexOf(cur);
  if (from < 0) return {};
  const skip = new Set<StageId>();
  if (!run.visual) skip.add('visual');
  if (run.quickFix || run.roundFiles?.length) { skip.add('review'); skip.add('visual'); }
  if (run.mergeOnly) { skip.add('review'); skip.add('visual'); skip.add('gate2'); }
  const out: Partial<Record<StageId, 'planned' | 'skip'>> = {};
  for (const id of ids.slice(from + 1)) out[id] = skip.has(id) ? 'skip' : 'planned';
  return out;
}

export function attemptsOf(run: RunFile, stage: StageId): StageAttempt[] {
  return run.attempts.filter((a) => a.stage === stage);
}
