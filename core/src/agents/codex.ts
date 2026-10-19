import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../proc.js';
import { addUsage, c, cleanEnv, clip, crlf, emptyUsage, explainError, type AgentResult, type AgentRunOptions } from './common.js';

export interface CodexOptions extends AgentRunOptions {
  /** danger-full-access — визуальной проверке: браузер, кэш npm и скриншоты вне рабочей копии. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** JSON Schema финального ответа (--output-schema). */
  outputSchema?: object;
  /** Сохранить сессию (без --ephemeral), чтобы продолжить её в следующем ходе чата. */
  persist?: boolean;
  /** Продолжить сохранённую сессию: codex exec resume <id>. */
  resumeThread?: string;
}

const KEY_ENV = 'PSFLOW_OPENAI_API_KEY';

export function codexProxyBase(p: NonNullable<AgentRunOptions['proxy']>): string {
  if (p.codexBaseUrl?.trim()) return p.codexBaseUrl.trim();
  const b = p.baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

/**
 * codex exec --json; промпт читается из stdin ("-").
 * Прокси подключаем отдельным провайдером через -c, не трогая ~/.codex/config.toml.
 */
export function codexArgs(o: Pick<CodexOptions, 'cwd' | 'model' | 'sandbox' | 'proxy' | 'images' | 'userConfig' | 'persist' | 'resumeThread'>, extra: { schemaFile?: string; lastFile: string }): string[] {
  // У resume нет -C и -s: папка — рабочая папка процесса, песочница — через -c.
  const args = o.resumeThread
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${o.sandbox}"`]
    : ['exec', '--json', ...(o.persist ? [] : ['--ephemeral']), '--skip-git-repo-check', '--color', 'never', '-C', o.cwd, '-s', o.sandbox];
  if (o.proxy?.baseUrl) {
    // С настройками пользователя его config.toml (MCP и прочее) остаётся, провайдер переопределяется поверх через -c.
    if (!o.userConfig) args.push('--ignore-user-config');
    args.push(
      '-c', 'model_provider=psflow',
      '-c', 'model_providers.psflow.name=psflow',
      '-c', `model_providers.psflow.base_url=${codexProxyBase(o.proxy)}`,
      '-c', `model_providers.psflow.env_key=${KEY_ENV}`,
      '-c', 'model_providers.psflow.wire_api=responses',
      // Прокси PurpleSchool не поддерживает WebSocket-транспорт Responses API.
      '-c', 'model_providers.psflow.supports_websockets=false',
    );
  }
  // Исполнителю и планировщику на codex нужна сеть (зависимости, openspec) — в песочнице workspace-write она выключена по умолчанию.
  if (o.sandbox === 'workspace-write') args.push('-c', 'sandbox_workspace_write.network_access=true');
  if (o.model) args.push('-m', o.model);
  if (extra.schemaFile) args.push('--output-schema', extra.schemaFile);
  // --image=… по одному: иначе многозначный -i проглотит завершающий «-» (промпт из stdin).
  for (const img of o.images ?? []) args.push(`--image=${img}`);
  args.push('-o', extra.lastFile);
  if (o.resumeThread) args.push(o.resumeThread);
  args.push('-');
  return args;
}

export async function runCodex(o: CodexOptions): Promise<AgentResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psflow-codex-'));
  const lastFile = path.join(tmp, 'last.txt');
  let schemaFile: string | undefined;
  if (o.outputSchema) {
    schemaFile = path.join(tmp, 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(o.outputSchema));
  }
  const env = cleanEnv(o.env);
  if (o.proxy?.baseUrl) env[KEY_ENV] = o.proxy.apiKey;

  let usage = emptyUsage();
  let lastMessage = '';
  const errors: string[] = [];
  const out = (s: string) => o.onOutput(crlf(s));
  const prompt = o.systemPrompt ? `${o.systemPrompt}\n\n---\n\n${o.prompt}` : o.prompt;

  const r = await run(o.bin, codexArgs(o, { schemaFile, lastFile }), {
    cwd: o.cwd,
    env,
    input: prompt,
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
      const item = ev.item as Record<string, unknown> | undefined;
      switch (ev.type) {
        case 'thread.started':
          out(c.dim(`● codex · ${o.model || 'модель по умолчанию'} · ${o.sandbox}`) + '\n');
          if (typeof ev.thread_id === 'string') o.onSession?.(ev.thread_id);
          break;
        case 'item.started':
          if (item?.type === 'command_execution') {
            out(c.violet('▸ ') + `shell ${c.dim(String(item.command ?? '').slice(0, 200))}` + '\n');
            o.onStep?.({ kind: 'tool', text: `shell ${String(item.command ?? '').split('\n')[0].slice(0, 160)}` });
          }
          break;
        case 'item.completed':
          if (!item) break;
          if (item.type === 'agent_message') {
            lastMessage = String(item.text ?? '');
            out(lastMessage.trim() + '\n');
            if (lastMessage.trim()) o.onStep?.({ kind: 'text', text: lastMessage.trim() });
          } else if (item.type === 'reasoning' && item.text) {
            out(c.dim(clip(String(item.text), 500)) + '\n');
          } else if (item.type === 'command_execution') {
            const o2 = String(item.aggregated_output ?? '');
            if (o2.trim()) out(((item.exit_code ?? 0) === 0 ? c.dim : c.coral)(clip(o2, 400)) + '\n');
          } else if (item.type === 'file_change') {
            const ch = (item.changes as { path: string; kind: string }[] | undefined) ?? [];
            out(c.violet('▸ ') + `правка ${c.dim(ch.map((x) => x.path).join(', '))}` + '\n');
            o.onStep?.({ kind: 'tool', text: `правка ${ch.map((x) => x.path).join(', ')}` });
          } else if (item.type === 'error') {
            errors.push(String(item.message ?? ''));
          }
          break;
        case 'turn.completed': {
          const u = (ev.usage ?? {}) as Record<string, number>;
          usage = addUsage(usage, {
            input: u.input_tokens ?? 0,
            output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
            cacheRead: u.cached_input_tokens ?? 0,
            cacheWrite: u.cache_write_input_tokens ?? 0,
          });
          break;
        }
        case 'turn.failed':
          errors.push(String((ev.error as { message?: string } | undefined)?.message ?? 'turn.failed'));
          break;
        case 'error':
          errors.push(String(ev.message ?? 'ошибка'));
          out(c.coral(String(ev.message ?? '')) + '\n');
          break;
      }
    },
  });

  let text = lastMessage;
  try {
    if (fs.existsSync(lastFile)) text = fs.readFileSync(lastFile, 'utf8') || lastMessage;
  } catch { /* остаётся lastMessage */ }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (r.killed) return { ok: false, text, usage, stopped: true, error: 'Остановлено' };
  if (r.timedOut) return { ok: false, text, usage, error: r.idle ? `codex: молчал ${Math.round((o.idleTimeoutMs ?? 0) / 60000)} мин — похоже, завис; остановлен` : `codex: превышен предельный таймаут ${Math.round(o.timeoutMs / 60000)} мин` };
  if (r.spawnError) return { ok: false, text: '', usage, error: `codex не запустился: ${r.spawnError}` };
  if (r.code !== 0 || (errors.length && !text.trim())) {
    return { ok: false, text, usage, error: explainError('codex', [...errors, r.stderr].join('\n') || `код выхода ${r.code}`) };
  }
  return { ok: true, text, usage };
}
