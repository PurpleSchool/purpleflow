import type { ChatMcpServer, ChatQuestion, ChatTodo, TokenUsage } from '../types.js';

export interface AgentRunOptions {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs: number;
  /** Остановить агента, если он столько молчит; общий timeoutMs — жёсткий потолок. */
  idleTimeoutMs?: number;
  group: string;
  onOutput: (text: string) => void;
  proxy?: { baseUrl: string; apiKey: string; codexBaseUrl?: string };
  claudeAuth?: 'login' | 'env';
  /** Подключать настройки пользователя (MCP, скиллы, плагины) вместо изолированного запуска. */
  userConfig?: boolean;
  /** Дополнительные каталоги, доступные агенту (вложения задачи). */
  addDirs?: string[];
  /** Изображения, прикреплённые к промпту (codex -i). */
  images?: string[];
  /** Ограничить набор инструментов агента (например, только чтение). */
  tools?: string[];
  /** claude: начать сессию с этим ID (она сохраняется, чтобы продолжить её в следующей попытке). */
  sessionId?: string;
  /** claude: продолжить сохранённую сессию. */
  resume?: string;
  /** Шаги ответа для чата: текст по мере генерации и вызовы инструментов, без ANSI. */
  onStep?: (step: AgentStep) => void;
  /** claude: присылать текст кусками по мере генерации (--include-partial-messages). */
  partial?: boolean;
  /** codex: ID сессии (thread), чтобы продолжить её в следующем ходе чата. */
  onSession?: (id: string) => void;
}

/**
 * Шаг ответа агента для чата.
 * text/thinking: delta — кусок, который дописывается к предыдущему; fresh — начало нового блока.
 * tool: повтор с тем же id обновляет вызов (сначала имя, потом аргументы); parent — вызов субагента внутри Task/Agent.
 * tool_result: итог вызова по id. notice: key — следующее уведомление с тем же ключом заменяет предыдущее.
 */
export type AgentStep =
  | { kind: 'text'; text: string; delta?: boolean; fresh?: boolean }
  | { kind: 'thinking'; text: string; delta?: boolean }
  | { kind: 'tool'; text: string; id?: string; parent?: string; detail?: string }
  | { kind: 'tool_result'; id: string; ok: boolean; output?: string; parent?: string }
  | { kind: 'todos'; items: ChatTodo[] }
  | { kind: 'question'; id?: string; questions: ChatQuestion[] }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; key?: string }
  | {
      kind: 'meta';
      model?: string;
      turns?: number;
      durationMs?: number;
      /** Сколько токенов контекста занято после последнего обращения к модели. */
      context?: number;
      /** Размер окна контекста модели. */
      contextWindow?: number;
      cwd?: string;
      version?: string;
      mcp?: ChatMcpServer[];
    };

export interface AgentResult {
  ok: boolean;
  /** Последний ответ агента (финальное сообщение). */
  text: string;
  usage: TokenUsage;
  error?: string;
  stopped?: boolean;
  /** Остановлен по таймауту (завис или работал слишком долго). */
  timedOut?: boolean;
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(a: TokenUsage, b: Partial<TokenUsage>): TokenUsage {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    costUsd: a.costUsd != null || b.costUsd != null ? (a.costUsd ?? 0) + (b.costUsd ?? 0) : undefined,
  };
}

// ANSI для живого лога в xterm.
export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  violet: (s: string) => `\x1b[38;2;178;165;245m${s}\x1b[39m`,
  sky: (s: string) => `\x1b[38;2;132;180;214m${s}\x1b[39m`,
  mint: (s: string) => `\x1b[38;2;116;196;160m${s}\x1b[39m`,
  amber: (s: string) => `\x1b[38;2;214;173;102m${s}\x1b[39m`,
  coral: (s: string) => `\x1b[38;2;223;126;141m${s}\x1b[39m`,
};

/** xterm требует \r\n. */
export const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

export function clip(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + c.dim(` … (+${t.length - max})`) : t;
}

/** Агентское окружение: без маркера родительской сессии Claude Code, из-за которого вложенный запуск ведёт себя иначе. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env };
  delete e.CLAUDECODE;
  delete e.ELECTRON_RUN_AS_NODE;
  e.NO_COLOR = '1';
  return e;
}

/** Понятное сообщение для типовых сбоев агента. */
export function explainError(agent: string, raw: string, auth: 'proxy' | 'login' | 'env' = 'proxy'): string {
  const t = raw.toLowerCase();
  if (
    /invalid api key|invalid x-api-key|authentication_error|unauthorized|\b401\b|not logged in|please run \/login|login required/.test(t)
  ) {
    if (auth === 'env')
      return `${agent}: ключ из окружения (ANTHROPIC_API_KEY в ~/.zshrc или другом файле шелла) недействителен. Исправьте его или в настройках выберите вход Claude Code.`;
    if (auth === 'login')
      return `${agent}: агент не авторизован. Выполните в терминале «${agent}» и войдите в аккаунт, либо войдите в аккаунт PurpleSchool в настройках.`;
    return `${agent}: прокси PurpleSchool отклонил ключ. Выберите действующий ключ в настройках, во вкладке «Аккаунт».`;
  }
  if (/credit balance|insufficient|quota|billing|payment required|\b402\b|out of (tokens|credits)/.test(t)) {
    return `${agent}: закончились токены или кредиты на балансе PurpleSchool.`;
  }
  if (/rate.?limit|\b429\b|overloaded|\b529\b/.test(t)) {
    return `${agent}: превышен лимит запросов или модель перегружена. Повторите позже.`;
  }
  if (/model.*(not found|does not exist|not available|unsupported)|unknown model|invalid model/.test(t)) {
    return `${agent}: модель недоступна. Проверьте имя модели для роли в настройках.`;
  }
  if (/enotfound|econnrefused|etimedout|network|fetch failed|connection error|getaddrinfo/.test(t)) {
    return `${agent}: нет соединения с прокси PurpleSchool. Проверьте сеть.`;
  }
  // Длинные строки без пробелов — base64 картинок и прочий бинарный мусор, причину они не объясняют.
  const line = raw
    .trim()
    .split('\n')
    .filter((l) => l.trim() && !/^[A-Za-z0-9+/=]{80,}$/.test(l.trim()))
    .slice(-3)
    .join(' ')
    .slice(0, 400);
  return `${agent}: ${line || 'завершился с ошибкой без сообщения'}`;
}

/** Без ANSI-последовательностей — вывод инструментов для чата. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

/** Вывод инструмента для чата: без ANSI и base64, не длиннее max. */
export function plainOutput(s: string, max = 2000): string {
  const t = stripAnsi(s)
    .split('\n')
    .filter((l) => !/^[A-Za-z0-9+/=]{200,}$/.test(l.trim()))
    .join('\n')
    .trim();
  return t.length > max ? `${t.slice(0, max)}\n… (+${t.length - max})` : t;
}

/** Шаг без пустых полей: в файле чата и в сравнениях не остаётся undefined. */
export function defined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
