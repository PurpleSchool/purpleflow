import type { CheckResult, ReviewItem, RunFile, StageId } from '@purpleflow/core';
import { limitRow } from '../../lib/stages';

/** Заголовок попытки в файле лога (orchestrator STAGE_TITLES). */
export const LOG_TITLE: Partial<Record<StageId, string>> = { implement: 'Реализация', finish: 'Завершение', clarify: 'Уточнение' };

/** Строка ганта, в которой сейчас прогон (или итоговая — для завершённого). */
export function currentStage(run: RunFile): StageId {
  if (run.status === 'finished') return 'gate2';
  if (run.next === 'limit') return limitRow(run);
  return run.next;
}

export const cleanErr = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function unstableText(u: NonNullable<CheckResult['unstable']>): string {
  const list = u.tests.length ? ` (${u.tests.slice(0, 4).join('; ')}${u.tests.length > 4 ? '…' : ''})` : '';
  const why =
    u.reason === 'retry'
      ? `Тесты упали${list}, а при повторе прошли`
      : u.reason === 'differs'
        ? `При повторе упали другие тесты${list}`
        : `Эти тесты падают и на исходном коде, без изменений задачи${list}`;
  return `${why} — похоже на нестабильность проекта, а не на ошибку задачи. На доработку не отправлено, решение за вами на приёмке; нестабильные тесты лучше чинить отдельной задачей.`;
}

export function originSummary(items: ReviewItem[]): string {
  const n = (o: ReviewItem['origin']) => items.filter((x) => x.origin === o).length;
  const parts = [
    n('unfixed') && `не исправлено с прошлого раза — ${n('unfixed')}`,
    n('from_fix') && `из‑за исправлений — ${n('from_fix')}`,
    n('new') && `новых — ${n('new')}`,
  ].filter(Boolean);
  return parts.length ? ` Из блокирующих: ${parts.join(', ')}.` : '';
}

/** Комментарий к «Поправить» с выбранными замечаниями ревьюера. */
export function withPicked(comment: string, picked: ReviewItem[]): string {
  if (!picked.length) return comment;
  const list = picked.map((i) => `- ${i.file ? `${i.file}${i.line ? ':' + i.line : ''} — ` : ''}${i.message}`).join('\n');
  return `${comment.trim() ? comment.trim() + '\n\n' : ''}Исправь эти замечания ревьюера (выбраны человеком на приёмке):\n${list}`;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
