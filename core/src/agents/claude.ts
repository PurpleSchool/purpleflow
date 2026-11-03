import { run } from '../proc.js';
import { addUsage, c, cleanEnv, clip, crlf, emptyUsage, explainError, type AgentResult, type AgentRunOptions } from './common.js';

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
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

function describeTool(name: string, input: Record<string, unknown> = {}): string {
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? input.url;
  return v ? `${name} ${c.dim(String(v).split('\n')[0].slice(0, 160))}` : name;
}

/** То же описание инструмента, но без ANSI — для чата. */
function plainTool(name: string, input: Record<string, unknown> = {}): string {
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? input.url;
  return v ? `${name} ${String(v).split('\n')[0].slice(0, 160)}` : name;
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
  const out = (s: string) => o.onOutput(crlf(s));

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
      if (ev.type === 'system' && ev.subtype === 'init') {
        out(c.dim(`● claude · ${String(ev.model ?? o.model ?? '')} · ${String(ev.cwd ?? '')}`) + '\n');
      } else if (ev.type === 'stream_event') {
        const se = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (se?.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text)
          o.onStep?.({ kind: 'text', text: se.delta.text, delta: true });
      } else if (ev.type === 'assistant') {
        const msg = ev.message as { content?: ContentBlock[] };
        for (const b of msg?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) {
            out(b.text.trim() + '\n');
            // С частичными сообщениями текст уже пришёл кусками.
            if (!o.partial) o.onStep?.({ kind: 'text', text: b.text.trim() });
          } else if (b.type === 'tool_use') {
            out(c.violet('▸ ') + describeTool(b.name ?? 'tool', b.input) + '\n');
            o.onStep?.({ kind: 'tool', text: plainTool(b.name ?? 'tool', b.input) });
          }
        }
      } else if (ev.type === 'user') {
        const msg = ev.message as { content?: ContentBlock[] };
        for (const b of msg?.content ?? []) {
          if (b.type === 'tool_result') {
            const t = toolResultText(b.content);
            if (t.trim()) out((b.is_error ? c.coral : c.dim)(clip(t, 400)) + '\n');
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
        if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype !== 'success')) {
          resultError = String(ev.result ?? ev.subtype ?? 'ошибка');
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
