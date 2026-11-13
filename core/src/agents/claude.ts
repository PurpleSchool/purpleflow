import { run } from '../proc.js';
import {
  addUsage,
  c,
  cleanEnv,
  clip,
  crlf,
  defined,
  emptyUsage,
  explainError,
  plainOutput,
  type AgentResult,
  type AgentRunOptions,
  type AgentStep,
} from './common.js';
import { questionsOf, todosOf, toolName, toolView } from './tools.js';

/**
 * claude -p (stdin) --output-format stream-json --verbose.
 * Флаги сверены с claude 2.1.x, см. README.
 */
export function claudeArgs(
  o: Pick<AgentRunOptions, 'model' | 'systemPrompt' | 'addDirs' | 'tools' | 'sessionId' | 'resume' | 'userConfig' | 'partial'>,
): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
  if (o.userConfig) {
    // Настройки пользователя (MCP, скиллы, плагины) — как в его обычном claude; только хуки выключены,
    // чтобы уведомления, логгеры и проверки из ~/.claude не срабатывали на каждом шаге прогона.
    args.push('--settings', JSON.stringify({ disableAllHooks: true }));
  } else {
    // Только настройки проекта: пользовательские хуки, плагины, MCP и env из ~/.claude не вмешиваются в прогон.
    args.push('--setting-sources', 'project,local', '--strict-mcp-config');
  }
  // Сессию сохраняем только исполнителю — чтобы следующая попытка продолжила её, а не читала проект заново.
  if (o.resume) args.push('--resume', o.resume);
  else if (o.sessionId) args.push('--session-id', o.sessionId);
  else args.push('--no-session-persistence');
  if (o.model) args.push('--model', o.model);
  if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
  for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  if (o.tools) args.push('--tools', o.tools.join(','));
  if (o.partial) args.push('--include-partial-messages');
  return args;
}

/**
 * Промпт и системный промпт запуска. На Windows claude.cmd идёт через cmd.exe: перевод строки в аргументе обрывает команду,
 * а длина ограничена 8 КБ, — поэтому системный промпт там уходит в stdin, как у codex.
 */
export function claudeInput(o: Pick<AgentRunOptions, 'prompt' | 'systemPrompt'>, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32' || !o.systemPrompt) return { prompt: o.prompt, systemPrompt: o.systemPrompt };
  return { prompt: `${o.systemPrompt}\n\n---\n\n${o.prompt}`, systemPrompt: undefined };
}

export function claudeEnv(o: Pick<AgentRunOptions, 'env' | 'proxy' | 'claudeAuth'>): NodeJS.ProcessEnv {
  const env = cleanEnv(o.env);
  if (o.proxy?.baseUrl) {
    // Прокси PurpleSchool проверяет ключ в заголовке x-api-key — его claude отправляет из ANTHROPIC_API_KEY.
    env.ANTHROPIC_BASE_URL = o.proxy.baseUrl;
    env.ANTHROPIC_API_KEY = o.proxy.apiKey;
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  } else if ((o.claudeAuth ?? 'login') === 'login') {
    // Без прокси — собственный вход Claude Code; ключ из окружения перекрыл бы его.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

/** Строка инструмента для живого лога: главный аргумент приглушён. */
function describeTool(name: string, input: Record<string, unknown> = {}): string {
  const { text } = toolView(name, input);
  const head = toolName(name);
  return text.startsWith(head + ' ') ? `${head} ${c.dim(text.slice(head.length + 1))}` : text;
}

/** Итоги result без текста ответа — понятной фразой. */
const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: 'достигнут предел ходов агента, ответ не закончен',
  error_max_budget_usd: 'исчерпан бюджет на запуск',
  error_during_execution: 'сбой во время работы агента',
};

/** Инструменты, у которых в чате своя часть вместо строки вызова. */
const OWN_PARTS = new Set(['TodoWrite', 'AskUserQuestion']);

const LIMIT_NAMES: Record<string, string> = { five_hour: 'пятичасового', seven_day: 'недельного' };

function resetsAt(sec: unknown): string {
  if (typeof sec !== 'number') return '';
  const d = new Date(sec * 1000);
  return ` до ${d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`;
}

/** Служебные события claude, которые человек должен видеть в чате: повторы запросов, сжатие контекста, MCP, лимиты. */
export function claudeNotice(ev: Record<string, unknown>): AgentStep[] {
  // Заполнение контекста — по обращению основного агента к модели: всё, что ушло на вход, плюс ответ.
  if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
    const u = (ev.message as { usage?: Record<string, unknown> } | undefined)?.usage;
    const n = (k: string) => (typeof u?.[k] === 'number' ? (u[k] as number) : 0);
    const used = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
    return used > 0 ? [{ kind: 'meta', context: used }] : [];
  }
  if (ev.type === 'result') {
    // Окно контекста — у модели с самым большим окном (основная; служебные вроде haiku — меньше).
    const windows = Object.values((ev.modelUsage ?? {}) as Record<string, { contextWindow?: unknown }>)
      .map((m) => m?.contextWindow)
      .filter((w): w is number => typeof w === 'number' && w > 0);
    return windows.length ? [{ kind: 'meta', contextWindow: Math.max(...windows) }] : [];
  }
  if (ev.type === 'rate_limit_event') {
    const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>;
    const kind = LIMIT_NAMES[String(info.rateLimitType)] ?? '';
    if (info.status === 'rejected')
      return [
        {
          kind: 'notice',
          level: 'error',
          key: 'rate',
          text: `Лимит ${kind ? kind + ' ' : ''}использования исчерпан${resetsAt(info.resetsAt)}`,
        },
      ];
    if (info.status === 'allowed_warning' && typeof info.utilization === 'number')
      return [
        {
          kind: 'notice',
          level: 'warn',
          key: 'rate',
          text: `Израсходовано ${Math.round(info.utilization * 100)}% ${kind ? kind + ' ' : ''}лимита${resetsAt(info.resetsAt).replace(' до', ', сброс')}`,
        },
      ];
    return [];
  }
  if (ev.type !== 'system') return [];
  switch (ev.subtype) {
    case 'init': {
      const out: AgentStep[] = [];
      const servers = ((ev.mcp_servers as { name?: string; status?: string }[] | undefined) ?? []).filter((m) => m?.name);
      out.push(
        defined({
          kind: 'meta' as const,
          model: typeof ev.model === 'string' && ev.model ? ev.model : undefined,
          cwd: typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : undefined,
          version: typeof ev.claude_code_version === 'string' ? ev.claude_code_version : undefined,
          mcp: servers.length ? servers.map((m) => ({ name: String(m.name), status: String(m.status ?? '') })) : undefined,
        }),
      );
      for (const m of servers) {
        if (m.status === 'failed')
          out.push({
            kind: 'notice',
            level: 'warn',
            key: `mcp:${m.name}`,
            text: `MCP-сервер ${m.name} не подключился — его инструменты агенту недоступны`,
          });
        else if (m.status === 'needs-auth')
          out.push({
            kind: 'notice',
            level: 'warn',
            key: `mcp:${m.name}`,
            text: `MCP-сервер ${m.name} требует входа — его инструменты агенту недоступны`,
          });
      }
      return out;
    }
    case 'api_retry': {
      const n = typeof ev.attempt === 'number' ? ` ${ev.attempt}${typeof ev.max_retries === 'number' ? ` из ${ev.max_retries}` : ''}` : '';
      const why = ev.error_status ? `, ответ ${String(ev.error_status)}` : typeof ev.error === 'string' ? `, ${ev.error}` : '';
      return [{ kind: 'notice', level: 'warn', key: 'retry', text: `Повтор запроса к модели: попытка${n}${why}` }];
    }
    case 'status':
      return ev.status === 'compacting' ? [{ kind: 'notice', level: 'info', key: 'compact', text: 'Сжимаю контекст переписки…' }] : [];
    case 'compact_boundary': {
      const m = (ev.compact_metadata ?? {}) as { pre_tokens?: unknown; post_tokens?: unknown };
      const pre = typeof m.pre_tokens === 'number' ? m.pre_tokens : undefined;
      const post = typeof m.post_tokens === 'number' ? m.post_tokens : undefined;
      const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)} тыс.` : String(n));
      return [
        {
          kind: 'notice',
          level: 'info',
          key: 'compact',
          text: `Контекст переписки сжат${pre != null && post != null ? ` (${k(pre)} → ${k(post)} токенов)` : ''}: ранние сообщения агент помнит в пересказе`,
        },
        // После сжатия контекст — пересказ: столько и занято.
        ...(post != null ? [{ kind: 'meta' as const, context: post }] : []),
      ];
    }
  }
  return [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  return '';
}

/** Последние осмысленные строки вывода: сообщения об ошибках из событий, без длинных base64 и JSON. */
function readableTail(stdout: string): string {
  const lines = stdout.split('\n').slice(-40);
  const out: string[] = [];
  for (const l of lines) {
    try {
      const ev = JSON.parse(l) as { type?: string; error?: unknown; message?: unknown; result?: unknown };
      const msg = ev.error ?? (ev.type === 'error' ? ev.message : undefined) ?? (ev.type === 'result' ? ev.result : undefined);
      if (typeof msg === 'string') out.push(msg);
      else if (msg) out.push(JSON.stringify(msg).slice(0, 300));
    } catch {
      const t = l.trim();
      if (t && !/^[A-Za-z0-9+/=]{80,}$/.test(t) && t.length < 600) out.push(t);
    }
  }
  return out.slice(-5).join('\n');
}

export async function runClaude(o: AgentRunOptions): Promise<AgentResult> {
  let usage = emptyUsage();
  let finalText = '';
  let resultError: string | undefined;
  let gotResult = false;
  /** Следующий кусок текста начинает новый текстовый блок. */
  let freshText = false;
  const out = (s: string) => o.onOutput(crlf(s));
  const step = (st: AgentStep) => o.onStep?.(st);

  const input = claudeInput(o);
  const r = await run(o.bin, claudeArgs({ ...o, systemPrompt: input.systemPrompt }), {
    cwd: o.cwd,
    env: claudeEnv(o),
    input: input.prompt,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    group: o.group,
    onStdoutLine: (line) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        out(c.dim(line) + '\n');
        return;
      }
      for (const st of claudeNotice(ev)) step(st);
      // Шаги субагента (Task/Agent) приходят с parent_tool_use_id: в чате они живут внутри его вызова.
      const parent = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined;
      if (ev.type === 'system' && ev.subtype === 'init') {
        out(c.dim(`● claude · ${String(ev.model ?? o.model ?? '')} · ${String(ev.cwd ?? '')}`) + '\n');
      } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
        out(c.amber(`повтор запроса: попытка ${String(ev.attempt ?? '?')}`) + '\n');
      } else if (ev.type === 'stream_event') {
        if (parent) return;
        const se = ev.event as
          | {
              type?: string;
              content_block?: ContentBlock;
              delta?: { type?: string; text?: string; thinking?: string };
            }
          | undefined;
        if (se?.type === 'content_block_start') {
          const b = se.content_block;
          if (b?.type === 'text') freshText = true;
          else if (b?.type === 'thinking') step({ kind: 'thinking', text: b.thinking ?? '' });
          // Вызов виден сразу, пока модель ещё пишет аргументы (большой Write иначе выглядит зависанием).
          else if (b?.type === 'tool_use' && b.id && b.name && !OWN_PARTS.has(b.name))
            step({ kind: 'tool', id: b.id, text: toolName(b.name) });
        } else if (se?.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
          step(defined({ kind: 'text', text: se.delta.text, delta: true, fresh: freshText || undefined }));
          freshText = false;
        } else if (se?.type === 'content_block_delta' && se.delta?.type === 'thinking_delta' && se.delta.thinking) {
          step({ kind: 'thinking', text: se.delta.thinking, delta: true });
        }
      } else if (ev.type === 'assistant') {
        const msg = ev.message as { content?: ContentBlock[] };
        for (const b of msg?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) {
            out((parent ? c.dim('  ') : '') + b.text.trim() + '\n');
            // С частичными сообщениями текст уже пришёл кусками; текст субагента — его отчёт основному агенту, не человеку.
            if (!o.partial && !parent) step({ kind: 'text', text: b.text.trim() });
          } else if (b.type === 'thinking' && b.thinking?.trim()) {
            if (!o.partial && !parent) step({ kind: 'thinking', text: b.thinking.trim() });
          } else if (b.type === 'tool_use') {
            const name = b.name ?? 'tool';
            out((parent ? c.dim('  ') : '') + c.violet('▸ ') + describeTool(name, b.input) + '\n');
            const todos = parent ? null : todosOf(name, b.input);
            const questions = parent ? null : questionsOf(name, b.input);
            if (todos) step({ kind: 'todos', items: todos });
            else if (questions) step(defined({ kind: 'question', id: b.id, questions }));
            else step(defined({ kind: 'tool', id: b.id, parent, ...toolView(name, b.input) }));
          }
        }
      } else if (ev.type === 'user') {
        const msg = ev.message as { content?: ContentBlock[] };
        for (const b of msg?.content ?? []) {
          if (b.type === 'tool_result') {
            const t = toolResultText(b.content);
            if (t.trim()) out((b.is_error ? c.coral : c.dim)(clip(t, 400)) + '\n');
            if (b.tool_use_id)
              step(defined({ kind: 'tool_result', id: b.tool_use_id, ok: !b.is_error, output: plainOutput(t) || undefined, parent }));
          }
        }
      } else if (ev.type === 'result') {
        gotResult = true;
        const u = (ev.usage ?? {}) as Record<string, number>;
        usage = addUsage(usage, {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        });
        finalText = typeof ev.result === 'string' ? ev.result : finalText;
        if (typeof ev.num_turns === 'number' || typeof ev.duration_ms === 'number')
          step(
            defined({
              kind: 'meta',
              turns: typeof ev.num_turns === 'number' ? ev.num_turns : undefined,
              durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
            }),
          );
        const denied = (Array.isArray(ev.permission_denials) ? ev.permission_denials : []) as {
          tool_name?: string;
          tool_input?: Record<string, unknown>;
        }[];
        if (denied.length)
          step({
            kind: 'notice',
            level: 'warn',
            key: 'denied',
            text: `Агенту не дали выполнить: ${denied.map((d) => toolView(d.tool_name ?? 'tool', d.tool_input).text).join('; ')}`,
          });
        if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype !== 'success')) {
          const sub = String(ev.subtype ?? '');
          resultError = String(
            (typeof ev.result === 'string' && ev.result.trim() ? ev.result : undefined) ?? RESULT_ERRORS[sub] ?? (sub || 'ошибка'),
          );
        }
      }
    },
  });

  if (r.killed) return { ok: false, text: finalText, usage, stopped: true, error: 'Остановлено' };
  if (r.timedOut)
    return {
      ok: false,
      text: finalText,
      usage,
      timedOut: true,
      error: r.idle
        ? `claude: молчал ${Math.round((o.idleTimeoutMs ?? 0) / 60000)} мин — похоже, завис; остановлен`
        : `claude: превышен предельный таймаут ${Math.round(o.timeoutMs / 60000)} мин`,
    };
  if (r.spawnError) return { ok: false, text: '', usage, error: `claude не запустился: ${r.spawnError}` };
  if (resultError || r.code !== 0 || !gotResult) {
    // Хвост stdout — это JSON-события; в них бывают картинки в base64 (ответ Read на скриншот), они не должны вытеснять причину.
    const tail = gotResult ? '' : readableTail(r.stdout);
    const raw = [resultError, r.stderr.trim(), tail].filter(Boolean).join('\n');
    if (r.stderr.trim()) out(c.coral(clip(r.stderr, 2000)) + '\n');
    const auth = o.proxy?.baseUrl ? 'proxy' : (o.claudeAuth ?? 'login');
    const why = raw
      ? explainError('claude', raw, auth)
      : `claude: завершился без ответа (код выхода ${r.code ?? '—'}${r.signal ? `, сигнал ${r.signal}` : ''})`;
    return { ok: false, text: finalText, usage, error: why };
  }
  return { ok: true, text: finalText, usage };
}
