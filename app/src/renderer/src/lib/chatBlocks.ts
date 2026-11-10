// Ответ агента в чате: части ответа → блоки ленты, ответ на вопрос агента, строка итогов хода.
import type { ChatMessage, ChatPart, ChatQuestion, ChatToolPart } from '@purpleflow/core';

export type ChatBlock = Exclude<ChatPart, ChatToolPart> | { kind: 'tools'; items: ChatToolPart[] };

/** Части ответа блоками: подряд идущие вызовы — одной группой. */
export function chatBlocks(m: Pick<ChatMessage, 'parts' | 'text'>): ChatBlock[] {
  const parts: ChatPart[] = m.parts?.length ? m.parts : m.text ? [{ kind: 'text', text: m.text }] : [];
  const out: ChatBlock[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.kind === 'tool') {
      if (last?.kind === 'tools') last.items.push(p);
      else out.push({ kind: 'tools', items: [p] });
    } else out.push(p);
  }
  return out;
}

/** Свёрнутая группа: последний вызов и все упавшие — ошибка не должна прятаться под «показать все». */
export function shownTools(items: ChatToolPart[], open: boolean): ChatToolPart[] {
  if (open) return items;
  return items.filter((t, i) => i === items.length - 1 || t.status === 'error');
}

/** Ответ человека на вопросы агента одним сообщением. */
export function answerText(questions: ChatQuestion[], picked: string[][]): string {
  if (questions.length === 1) return picked[0].join(', ');
  return questions.map((q, i) => `${q.question} — ${picked[i]?.join(', ') || 'без ответа'}`).join('\n');
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

/** Итоги хода под ответом: модель, ходы, время. Токены и стоимость в чате не показываем. */
export function answerFooter(m: Pick<ChatMessage, 'model' | 'turns' | 'durationMs'>): string[] {
  const out: string[] = [];
  if (m.model) out.push(m.model);
  if (m.turns)
    out.push(
      `${m.turns} ${m.turns % 10 === 1 && m.turns % 100 !== 11 ? 'ход' : m.turns % 10 >= 2 && m.turns % 10 <= 4 && (m.turns % 100 < 12 || m.turns % 100 > 14) ? 'хода' : 'ходов'}`,
    );
  if (m.durationMs) out.push(seconds(m.durationMs));
  return out;
}
