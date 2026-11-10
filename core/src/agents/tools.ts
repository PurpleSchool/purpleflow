// Вызовы инструментов claude в виде, понятном человеку: строка для чата, подробности, план и вопросы агента.
import type { ChatQuestion, ChatTodo } from '../types.js';

type Input = Record<string, unknown>;

/** Аргумент, по которому видно, что делает вызов, — в порядке важности. */
const MAIN_ARG = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'query',
  'url',
  'skill',
  'subject',
  'description',
  'prompt',
] as const;

const SUBAGENT = new Set(['Task', 'Agent']);

const firstLine = (v: unknown, max = 160) => String(v).trim().split('\n')[0].slice(0, max);

function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (+${s.length - max})` : s;
}

function lines(s: unknown, max: number): string[] {
  return String(s ?? '')
    .split('\n')
    .slice(0, max);
}

/** Мини-дифф правки: строки «было» с минусом, «стало» с плюсом. */
function editDiff(oldS: unknown, newS: unknown): string {
  return [...lines(oldS, 30).map((l) => `- ${l}`), ...lines(newS, 30).map((l) => `+ ${l}`)].join('\n');
}

/** Имя MCP-инструмента mcp__server__tool → «server · tool». */
export function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** Строка вызова и подробности, которые видны, если раскрыть шаг. */
export function toolView(name: string, input: Input = {}): { text: string; detail?: string } {
  if (SUBAGENT.has(name)) {
    const kind = input.subagent_type ? ` ${String(input.subagent_type)}` : '';
    const what = input.description ? `: ${firstLine(input.description)}` : '';
    return { text: `Субагент${kind}${what}`, detail: input.prompt ? clipText(String(input.prompt), 3000) : undefined };
  }
  const key = MAIN_ARG.find((k) => input[k] != null && String(input[k]).trim());
  const text = key ? `${toolName(name)} ${firstLine(input[key])}` : toolName(name);
  let detail: string | undefined;
  if (name === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command.trim();
    if (cmd.includes('\n') || cmd.length > 160) detail = cmd;
  } else if (name === 'Edit' && (input.old_string != null || input.new_string != null)) {
    detail = editDiff(input.old_string, input.new_string);
  } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    detail = (input.edits as Input[]).map((e) => editDiff(e.old_string, e.new_string)).join('\n…\n');
  } else if (name === 'Write' && typeof input.content === 'string') {
    const all = input.content.split('\n');
    detail = all.slice(0, 40).join('\n') + (all.length > 40 ? `\n… (ещё ${all.length - 40} строк)` : '');
  } else if (name === 'NotebookEdit' && typeof input.new_source === 'string') {
    detail = input.new_source;
  }
  return { text, detail: detail ? clipText(detail, 3000) : undefined };
}

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);

/** План агента из TodoWrite; null — это не TodoWrite или список пуст. */
export function todosOf(name: string, input: Input = {}): ChatTodo[] | null {
  if (name !== 'TodoWrite' || !Array.isArray(input.todos)) return null;
  const items = (input.todos as Input[])
    .map((t) => ({
      text: String(t.content ?? t.subject ?? '').trim(),
      status: (TODO_STATUS.has(String(t.status)) ? t.status : 'pending') as ChatTodo['status'],
    }))
    .filter((t) => t.text);
  return items.length ? items : null;
}

/** Вопросы AskUserQuestion; null — это другой инструмент. */
export function questionsOf(name: string, input: Input = {}): ChatQuestion[] | null {
  if (name !== 'AskUserQuestion' || !Array.isArray(input.questions)) return null;
  const qs = (input.questions as Input[])
    .map((q) => ({
      question: String(q.question ?? '').trim(),
      header: q.header ? String(q.header) : undefined,
      multiSelect: q.multiSelect === true ? true : undefined,
      options: (Array.isArray(q.options) ? (q.options as Input[]) : [])
        .map((o) => ({ label: String(o.label ?? '').trim(), description: o.description ? String(o.description) : undefined }))
        .filter((o) => o.label),
    }))
    .filter((q) => q.question);
  // Пустые поля не сохраняем: так шаг проще сравнивать и меньше весит в файле чата.
  for (const q of qs) {
    if (!q.header) delete q.header;
    if (!q.multiSelect) delete q.multiSelect;
    for (const o of q.options) if (!o.description) delete o.description;
  }
  return qs.length ? qs : null;
}
