import { run } from '../proc.js';
import { addUsage, c, cleanEnv, clip, crlf, emptyUsage, explainError, type AgentResult, type AgentRunOptions } from './common.js';

/**
 * claude -p (stdin) --output-format stream-json --verbose.
 * Флаги сверены с claude 2.1.x, см. README.
 */
export function claudeArgs(o: Pick<AgentRunOptions, 'model' | 'systemPrompt'>): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    // Только настройки проекта: пользовательские хуки, плагины и env из ~/.claude не вмешиваются в прогон.
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  if (o.model) args.push('--model', o.model);
  if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
  return args;
}

export function claudeEnv(o: Pick<AgentRunOptions, 'env' | 'proxy' | 'claudeAuth'>): NodeJS.ProcessEnv {
  const env = cleanEnv(o.env);
  if (o.proxy?.baseUrl) {
    env.ANTHROPIC_BASE_URL = o.proxy.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = o.proxy.apiKey;
    delete env.ANTHROPIC_API_KEY;
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

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  return '';
}

export async function runClaude(o: AgentRunOptions): Promise<AgentResult> {
  let usage = emptyUsage();
  let finalText = '';
  let resultError: string | undefined;
  let gotResult = false;
  const out = (s: string) => o.onOutput(crlf(s));

  const r = await run(o.bin, claudeArgs(o), {
    cwd: o.cwd,
    env: claudeEnv(o),
    input: o.prompt,
    timeoutMs: o.timeoutMs,
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
      } else if (ev.type === 'assistant') {
        const msg = ev.message as { content?: ContentBlock[] };
        for (const b of msg?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) out(b.text.trim() + '\n');
          else if (b.type === 'tool_use') out(c.violet('▸ ') + describeTool(b.name ?? 'tool', b.input) + '\n');
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
  if (r.timedOut) return { ok: false, text: finalText, usage, error: `claude: превышен таймаут ${Math.round(o.timeoutMs / 60000)} мин` };
  if (r.spawnError) return { ok: false, text: '', usage, error: `claude не запустился: ${r.spawnError}` };
  if (resultError || r.code !== 0 || !gotResult) {
    const raw = [resultError, r.stderr, gotResult ? '' : r.stdout.slice(-2000)].filter(Boolean).join('\n');
    const auth = o.proxy?.baseUrl ? 'proxy' : (o.claudeAuth ?? 'login');
    return { ok: false, text: finalText, usage, error: explainError('claude', raw || `код выхода ${r.code}`, auth) };
  }
  return { ok: true, text: finalText, usage };
}
