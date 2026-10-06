import type { RunFile, StageAttempt, StageId } from '@psflow/core';

export interface StageDef {
  id: StageId;
  title: string;
  actor: 'claude' | 'codex' | 'человек' | 'оркестратор';
  role?: 'planner' | 'executor' | 'reviewer';
  gate?: boolean;
  hint: string;
}

/** Порядок станций на рельсе. «limit» — не станция, а остановка с вопросом. */
export const STAGES: StageDef[] = [
  { id: 'plan', title: 'План', actor: 'claude', role: 'planner', hint: 'Изменение OpenSpec: proposal, tasks, дельты спецификаций' },
  { id: 'gate1', title: 'Утверждение плана', actor: 'человек', gate: true, hint: 'Принять, вернуть с комментарием или отменить' },
  { id: 'implement', title: 'Реализация', actor: 'claude', role: 'executor', hint: 'Выполняет tasks.md в отдельной worktree' },
  { id: 'tests', title: 'Тесты', actor: 'оркестратор', hint: 'Команда тестов проекта' },
  { id: 'review', title: 'Ревью', actor: 'codex', role: 'reviewer', hint: 'Другая модель сверяет дифф с планом' },
  { id: 'gate2', title: 'Приёмка', actor: 'человек', gate: true, hint: 'Дифф, замечания ревью и ваши замечания' },
  { id: 'finish', title: 'Архив и коммит', actor: 'оркестратор', hint: 'openspec archive и коммит в ветку psflow/…' },
];

export type NodeState = 'idle' | 'active' | 'waiting' | 'done' | 'failed' | 'stopped' | 'stale';

const order = (id: StageId) => (id === 'limit' ? STAGES.findIndex((s) => s.id === 'review') + 0.5 : STAGES.findIndex((s) => s.id === id));

export function lastAttempt(run: RunFile, stage: StageId): StageAttempt | undefined {
  for (let i = run.attempts.length - 1; i >= 0; i--) if (run.attempts[i].stage === stage) return run.attempts[i];
  return undefined;
}

export function nodeState(run: RunFile, stage: StageId): NodeState {
  const a = lastAttempt(run, stage);
  if (run.status === 'finished') return 'done';
  const cur = order(run.next);
  const me = order(stage);
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
