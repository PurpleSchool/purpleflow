import type { TokenUsage } from '../types.js';

export interface AgentRunOptions {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs: number;
  group: string;
  onOutput: (text: string) => void;
  proxy?: { baseUrl: string; apiKey: string; codexBaseUrl?: string };
  claudeAuth?: 'login' | 'env';
  /** Дополнительные каталоги, доступные агенту (вложения задачи). */
  addDirs?: string[];
  /** Изображения, прикреплённые к промпту (codex -i). */
  images?: string[];
}

export interface AgentResult {
  ok: boolean;
  /** Последний ответ агента (финальное сообщение). */
  text: string;
  usage: TokenUsage;
  error?: string;
  stopped?: boolean;
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
  if (/invalid api key|invalid x-api-key|authentication_error|unauthorized|401|not logged in|please run \/login|login required/.test(t)) {
    if (auth === 'env') return `${agent}: ключ из окружения (ANTHROPIC_API_KEY в ~/.zshrc или другом файле шелла) недействителен. Исправьте его или в настройках выберите вход Claude Code.`;
    if (auth === 'login') return `${agent}: агент не авторизован. Выполните в терминале «${agent}» и войдите в аккаунт, либо задайте прокси в настройках.`;
    return `${agent}: прокси отклонил ключ. Проверьте base URL и ключ в настройках.`;
  }
  if (/credit balance|insufficient|quota|billing|payment required|402|out of (tokens|credits)/.test(t)) {
    return `${agent}: закончились токены или кредиты на балансе прокси.`;
  }
  if (/rate.?limit|429|overloaded|529/.test(t)) {
    return `${agent}: превышен лимит запросов или модель перегружена. Повторите позже.`;
  }
  if (/model.*(not found|does not exist|not available|unsupported)|unknown model|invalid model/.test(t)) {
    return `${agent}: модель недоступна. Проверьте имя модели для роли в настройках.`;
  }
  if (/enotfound|econnrefused|etimedout|network|fetch failed|connection error|getaddrinfo/.test(t)) {
    return `${agent}: нет соединения с прокси. Проверьте base URL и сеть.`;
  }
  const line = raw.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
  return `${agent}: ${line || 'завершился с ошибкой без сообщения'}`;
}
