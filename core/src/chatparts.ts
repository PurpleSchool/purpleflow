// Сборка ответа чата из шагов агента: текст кусками, вызовы с итогами, шаги субагентов, план, уведомления.
import { defined, type AgentStep } from './agents/common.js';
import type { ChatMessage, ChatPart, ChatToolPart } from './types.js';

export type ChatAnswer = Pick<ChatMessage, 'model' | 'turns' | 'durationMs' | 'info'> & { parts: ChatPart[] };

function findTool(parts: ChatPart[], id: string): ChatToolPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === 'tool' && p.id === id) return p;
  }
  return undefined;
}

/** Применить шаг агента к ответу. */
export function applyStep(a: ChatAnswer, st: AgentStep): void {
  const parts = a.parts;
  const last = parts[parts.length - 1];
  switch (st.kind) {
    case 'text':
      if (st.delta && !st.fresh && last?.kind === 'text') last.text += st.text;
      else parts.push({ kind: 'text', text: st.text });
      return;
    case 'thinking':
      if (st.delta && last?.kind === 'thinking') last.text += st.text;
      else parts.push({ kind: 'thinking', text: st.text });
      return;
    case 'tool': {
      if (st.parent) {
        // Шаг субагента — внутри его вызова; без вызова показывать его негде, в ленту основного агента он не идёт.
        const owner = findTool(parts, st.parent);
        if (!owner) return;
        const sub = (owner.sub ??= []);
        const cur = st.id ? sub.find((x) => x.id === st.id) : undefined;
        if (cur) cur.text = st.text;
        else sub.push(defined({ text: st.text, id: st.id, status: st.id ? ('running' as const) : undefined }));
        return;
      }
      const cur = st.id ? findTool(parts, st.id) : undefined;
      if (cur) {
        cur.text = st.text;
        if (st.detail) cur.detail = st.detail;
        return;
      }
      parts.push(defined({ kind: 'tool', text: st.text, id: st.id, status: st.id ? ('running' as const) : undefined, detail: st.detail }));
      return;
    }
    case 'tool_result': {
      const status = st.ok ? 'ok' : 'error';
      if (st.parent) {
        const s = findTool(parts, st.parent)?.sub?.find((x) => x.id === st.id);
        if (s) s.status = status;
        return;
      }
      const t = findTool(parts, st.id);
      if (!t) return;
      t.status = status;
      if (st.output) t.output = st.output;
      return;
    }
    case 'todos': {
      // План один: обновлённый встаёт в конец, где его видно, а прежний убирается.
      const i = parts.findIndex((p) => p.kind === 'todos');
      if (i >= 0) parts.splice(i, 1);
      parts.push({ kind: 'todos', items: st.items.map((t) => ({ ...t })) });
      return;
    }
    case 'question':
      parts.push(defined({ kind: 'question', id: st.id, questions: st.questions }));
      return;
    case 'notice': {
      const next: ChatPart = defined({ kind: 'notice', level: st.level, text: st.text, key: st.key });
      const i = st.key ? parts.findIndex((p) => p.kind === 'notice' && p.key === st.key) : -1;
      if (i >= 0) parts[i] = next;
      else parts.push(next);
      return;
    }
    case 'meta':
      if (st.model) a.model = st.model;
      if (st.turns != null) a.turns = st.turns;
      if (st.durationMs != null) a.durationMs = st.durationMs;
      if (st.context != null || st.contextWindow != null || st.cwd || st.version || st.mcp) {
        a.info = {
          ...a.info,
          ...defined({ context: st.context, contextWindow: st.contextWindow, cwd: st.cwd, version: st.version, mcp: st.mcp }),
        };
      }
      return;
  }
}

/** Конец хода: вызовы без итога больше не выполняются — снимаем с них «выполняется». */
export function settleParts(parts: ChatPart[]): void {
  for (const p of parts) {
    if (p.kind !== 'tool') continue;
    if (p.status === 'running') delete p.status;
    for (const s of p.sub ?? []) if (s.status === 'running') delete s.status;
  }
}

/** Текст ответа — склеенные текстовые части. */
export const partsText = (parts: ChatPart[]) =>
  parts
    .filter((p): p is Extract<ChatPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n\n');
