import { run } from '../proc.js';
import {
  addUsage,
  cleanEnv,
  clip,
  crlf,
  emptyUsage,
  plainOutput,
  type AgentResult,
  type AgentRunOptions,
  type AgentStep,
} from './common.js';

export interface OpenCodeOptions extends AgentRunOptions {
  /** Разрешения инструментов, а не песочница ОС. В режиме чтения shell, MCP и подагенты недоступны. */
  readOnly?: boolean;
  /** У run нет --output-schema: схема передаётся в инструкции, ответ проверяет вызывающая стадия. */
  outputSchema?: object;
}

const READ_AGENT = 'purpleflow-readonly';
const READ_ACTIONS = ['read', 'glob', 'grep', 'webfetch', 'websearch', 'skill', 'external_directory'];

export function openCodeArgs(o: Pick<OpenCodeOptions, 'model' | 'resume' | 'images' | 'readOnly'>): string[] {
  // Частный сервер принадлежит процессу run: остановка дерева не затрагивает пользовательский сервер.
  const args = ['--standalone', 'run', '--format', 'json', '--thinking', '--auto'];
  if (o.model?.trim()) args.push('--model', o.model.trim());
  if (o.resume) args.push('--session', o.resume);
  if (o.readOnly) args.push('--agent', READ_AGENT);
  for (const image of o.images ?? []) args.push(`--file=${image}`);
  return args;
}

/** Провайдеры и вход остаются у OpenCode: общий прокси PurpleFlow не переписывает их. */
export function openCodeEnv(o: Pick<OpenCodeOptions, 'env' | 'cwd' | 'readOnly'>): NodeJS.ProcessEnv {
  const env = cleanEnv(o.env);
  // CLI предпочитает PWD рабочей папке процесса, включая унаследованный PWD родительского терминала.
  env.PWD = o.cwd;
  if (o.readOnly) {
    const raw: unknown = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    const config = record(raw);
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...config,
      agents: {
        ...record(config.agents),
        [READ_AGENT]: {
          mode: 'primary',
          description: 'PurpleFlow: чтение и анализ без изменения файлов',
          permissions: [
            { action: '*', resource: '*', effect: 'deny' },
            ...READ_ACTIONS.map((action) => ({ action, resource: '*', effect: 'allow' })),
          ],
        },
      },
    });
  }
  return env;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const number = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Состояние одного run: неизвестные события совместимы вперёд, ошибки протокола не становятся успешным ответом. */
export class OpenCodeStream {
  usage = emptyUsage();
  answer = '';
  error = '';
  finished = false;
  private session = '';
  private message = '';
  private readonly finishedSteps = new Set<string>();
  private readonly tools = new Set<string>();

  constructor(private readonly output: Pick<AgentRunOptions, 'onOutput' | 'onStep' | 'onSession'>) {}

  accept(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.output.onOutput(crlf(clip(line, 1000) + '\n'));
      return;
    }
    const event = record(raw);
    const part = record(event.part);
    const session = text(event.sessionID);
    if (session && !this.session) {
      this.session = session;
      this.output.onSession?.(session);
    }
    if (session && session !== this.session) return;
    const emit = (step: AgentStep) => this.output.onStep?.(step);
    switch (event.type) {
      case 'text': {
        const value = text(part.text);
        if (!value) break;
        const id = text(part.messageID);
        const fresh = Boolean(id && id !== this.message);
        if (fresh) this.answer = '';
        this.message = id || this.message;
        this.answer += value;
        emit({ kind: 'text', text: value, delta: true, fresh });
        this.output.onOutput(crlf(value));
        break;
      }
      case 'reasoning':
        if (text(part.text)) emit({ kind: 'thinking', text: text(part.text), delta: true });
        break;
      case 'tool_use': {
        const id = text(part.id) || text(part.callID) || text(part.partID);
        if (!id || this.tools.has(id)) break;
        const state = record(part.state);
        if (state.status !== 'completed' && state.status !== 'error') break;
        this.tools.add(id);
        const name = text(part.tool) || 'tool';
        const input = record(state.input);
        const main = Object.values(input).find((v) => typeof v === 'string');
        const label = `${name}${main ? ` ${clip(String(main), 160)}` : ''}`;
        emit({ kind: 'tool', id, text: label, detail: clip(JSON.stringify(input, null, 2), 3000) });
        const metadata = record(state.metadata);
        const nested = record(metadata.metadata);
        const result = text(state.error) || text(state.output) || text(metadata.output) || text(nested.output);
        const exit = metadata.exit ?? nested.exit;
        emit({
          kind: 'tool_result',
          id,
          ok: state.status === 'completed' && (typeof exit !== 'number' || exit === 0),
          output: plainOutput(result) || undefined,
        });
        this.output.onOutput(crlf(`▸ ${label}\n`));
        break;
      }
      case 'step_finish': {
        const id = text(part.messageID) || text(part.id);
        if (!id || this.finishedSteps.has(id)) break;
        this.finishedSteps.add(id);
        const tokens = record(part.tokens);
        const cache = record(tokens.cache);
        this.usage = addUsage(this.usage, {
          input: number(tokens.input),
          output: number(tokens.output) + number(tokens.reasoning),
          cacheRead: number(cache.read),
          cacheWrite: number(cache.write),
          costUsd: number(part.cost),
        });
        this.finished = true;
        break;
      }
      case 'retry':
        emit({ kind: 'notice', level: 'warn', key: 'retry', text: `OpenCode: ${text(record(event.error).message) || 'повтор запроса'}` });
        break;
      case 'error': {
        const error = record(event.error);
        this.error = text(error.message) || text(record(error.data).message) || text(event.error) || 'OpenCode: ошибка выполнения';
        emit({ kind: 'notice', level: 'warn', text: this.error });
        break;
      }
    }
  }
}

export async function runOpenCode(o: OpenCodeOptions): Promise<AgentResult> {
  const stream = new OpenCodeStream(o);
  let env: NodeJS.ProcessEnv;
  try {
    env = openCodeEnv(o);
  } catch {
    return { ok: false, text: '', usage: emptyUsage(), error: 'OpenCode: OPENCODE_CONFIG_CONTENT содержит некорректный JSON' };
  }
  const prompt = [
    o.systemPrompt,
    o.addDirs?.length ? `Дополнительные каталоги контекста (только чтение):\n${o.addDirs.join('\n')}` : undefined,
    o.prompt,
    o.outputSchema ? `Ответь только JSON, соответствующим схеме:\n${JSON.stringify(o.outputSchema)}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = await run(o.bin, openCodeArgs(o), {
    cwd: o.cwd,
    env,
    input: prompt,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    group: o.group,
    onStdoutLine: (line) => stream.accept(line),
  });
  const base = { text: stream.answer, usage: stream.usage };
  if (result.killed) return { ...base, ok: false, stopped: true, error: 'Остановлено' };
  if (result.timedOut)
    return {
      ...base,
      ok: false,
      timedOut: true,
      error: result.idle ? 'OpenCode: превышен таймаут ожидания вывода' : 'OpenCode: превышен предельный таймаут',
    };
  if (result.spawnError) return { ...base, ok: false, error: `OpenCode не запустился: ${result.spawnError}` };
  if (stream.error || result.code !== 0)
    return { ...base, ok: false, error: `OpenCode: ${stream.error || plainOutput(result.stderr) || `код выхода ${result.code}`}` };
  if (!stream.finished) return { ...base, ok: false, error: 'OpenCode: поток завершился без step_finish. Требуется OpenCode V2.' };
  return { ...base, ok: true };
}
