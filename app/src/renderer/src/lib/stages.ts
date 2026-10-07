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
    mode === 'quick' ? ['implement', 'tests', ...v, 'review', 'gate2', 'finish']
    : mode === 'refactor' ? ['baseline', 'plan', 'gate1', 'implement', 'tests', ...v, 'review', 'gate2', 'finish']
    : ['plan', 'gate1', 'implement', 'tests', ...v, 'review', 'gate2', 'finish'];
  return ids.map((id) => ({ ...BASE[id], ...OVERRIDE[mode]?.[id] }));
}

export const runStages = (run: Pick<RunFile, 'mode' | 'visual'>) => stagesFor((run.mode ?? 'task') as Mode, Boolean(run.visual));

/** Стадии обычной задачи — для мест, где режим не важен. */
export const STAGES: StageDef[] = stagesFor('task');

export const stageTitle = (run: Pick<RunFile, 'mode' | 'visual'>, id: StageId) =>
  runStages(run).find((s) => s.id === id)?.title ?? BASE[id]?.title ?? id;

export type NodeState = 'idle' | 'active' | 'waiting' | 'done' | 'failed' | 'stopped' | 'stale';

function order(run: RunFile, id: StageId): number {
  const ids = runStages(run).map((s) => s.id);
  return id === 'limit' ? ids.indexOf('gate2') - 0.5 : ids.indexOf(id);
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
  if (stage === run.next) {
    if (run.status === 'waiting') return 'waiting';
    if (run.status === 'running') return 'active';
    if (a?.status === 'failed') return 'failed';
    if (run.status === 'stopped' || run.status === 'cancelled') return 'stopped';
  }
  if (!a) return 'idle';
  if (me > cur) return 'stale';
  if (a.status === 'failed') return me < cur ? 'done' : 'failed';
  if (a.status === 'stopped') return 'stopped';
  return 'done';
}

export function attemptsOf(run: RunFile, stage: StageId): StageAttempt[] {
  return run.attempts.filter((a) => a.stage === stage);
}
