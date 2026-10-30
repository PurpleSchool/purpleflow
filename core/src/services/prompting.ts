// Общие блоки промптов: задача с уточнениями, правила режима, этап, обратная связь.
import type { Kernel } from '../kernel.js';

import type { Feedback, RunFile } from '../types.js';

/** Задача с ответами на вопросы уточнения — её видят все стадии. */
export function taskText(k: Kernel, run: RunFile): string {
  const a = run.clarify?.answers?.filter((x) => x.a.trim());
  if (!a?.length) return run.task;
  return `${run.task}\n\nУточнения от человека:\n${a.map((x) => `- ${x.q} — ${x.a}`).join('\n')}`;
}

/** Правила режима — дополнение к системному промпту роли (prompts/<role>.<mode>.md). */
export function modeRules(k: Kernel, role: 'planner' | 'executor' | 'review' | 'visual', run: RunFile): string {
  const file = `${role}.${run.mode}.md`;
  try {
    return '\n\n' + k.prompts.raw(file);
  } catch {
    return '';
  }
}

/** Шаблон промпта режима, если есть (implement.quick.md), иначе общий. */
export function tpl(k: Kernel, base: string, run: RunFile): string {
  const name = `${base}.${run.mode}.md`;
  try {
    k.prompts.raw(name);
    return name;
  } catch {
    return `${base}.md`;
  }
}

export function phaseBlock(k: Kernel, run: RunFile): string {
  if (run.mode !== 'epic' || !run.phases) return '';
  return `\n## Этап ${run.phase ?? 1} из ${run.phases}\n\nВыполни только пункты раздела «## ${run.phase ?? 1}.» в tasks.md. Следующие этапы не трогай — они будут отдельными шагами после проверок.\n`;
}

export function feedbackBlock(k: Kernel, f?: Feedback): string {
  if (!f) return '';
  const source = { validator: 'валидатор OpenSpec', tests: 'тесты', review: 'ревьюер', human: 'человек', system: 'оркестратор' }[f.source];
  const lines = f.lineComments?.length
    ? '\nЗамечания на строках:\n' +
      f.lineComments.map((l) => `- ${l.file}:${l.line}${l.quote ? ` («${l.quote}»)` : ''} — ${l.text}`).join('\n')
    : '';
  return k.prompts.render('feedback.md', { source, text: f.text, lineComments: lines });
}
