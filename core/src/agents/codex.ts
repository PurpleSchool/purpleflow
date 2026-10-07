import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../proc.js';
import { addUsage, c, cleanEnv, clip, crlf, emptyUsage, explainError, type AgentResult, type AgentRunOptions } from './common.js';

export interface CodexOptions extends AgentRunOptions {
  sandbox: 'read-only' | 'workspace-write';
  /** JSON Schema финального ответа (--output-schema). */
  outputSchema?: object;
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
export function codexArgs(o: Pick<CodexOptions, 'cwd' | 'model' | 'sandbox' | 'proxy' | 'images'>, extra: { schemaFile?: string; lastFile: string }): string[] {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-C', o.cwd, '-s', o.sandbox];
  if (o.proxy?.baseUrl) {
    args.push(
      '--ignore-user-config',
      '-c', 'model_provider=psflow',
      '-c', 'model_providers.psflow.name=psflow',
      '-c', `model_providers.psflow.base_url=${codexProxyBase(o.proxy)}`,
      '-c', `model_providers.psflow.env_key=${KEY_ENV}`,
      '-c', 'model_providers.psflow.wire_api=responses',
    );
  }
  // Исполнителю и планировщику на codex нужна сеть (зависимости, openspec) — в песочнице workspace-write она выключена по умолчанию.
  if (o.sandbox === 'workspace-write') args.push('-c', 'sandbox_workspace_write.network_access=true');
  if (o.model) args.push('-m', o.model);
  if (extra.schemaFile) args.push('--output-schema', extra.schemaFile);
  // --image=… по одному: иначе многозначный -i проглотит завершающий «-» (промпт из stdin).
  for (const img of o.images ?? []) args.push(`--image=${img}`);
  args.push('-o', extra.lastFile, '-');
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
          break;
        case 'item.started':
          if (item?.type === 'command_execution') out(c.violet('▸ ') + `shell ${c.dim(String(item.command ?? '').slice(0, 200))}` + '\n');
          break;
        case 'item.completed':
          if (!item) break;
          if (item.type === 'agent_message') {
            lastMessage = String(item.text ?? '');
            out(lastMessage.trim() + '\n');
          } else if (item.type === 'reasoning' && item.text) {
            out(c.dim(clip(String(item.text), 500)) + '\n');
          } else if (item.type === 'command_execution') {
            const o2 = String(item.aggregated_output ?? '');
            if (o2.trim()) out(((item.exit_code ?? 0) === 0 ? c.dim : c.coral)(clip(o2, 400)) + '\n');
          } else if (item.type === 'file_change') {
            const ch = (item.changes as { path: string; kind: string }[] | undefined) ?? [];
            out(c.violet('▸ ') + `правка ${c.dim(ch.map((x) => x.path).join(', '))}` + '\n');
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
  if (r.timedOut) return { ok: false, text, usage, error: `codex: превышен таймаут ${Math.round(o.timeoutMs / 60000)} мин` };
  if (r.spawnError) return { ok: false, text: '', usage, error: `codex не запустился: ${r.spawnError}` };
  if (r.code !== 0 || (errors.length && !text.trim())) {
    return { ok: false, text, usage, error: explainError('codex', [...errors, r.stderr].join('\n') || `код выхода ${r.code}`) };
  }
  return { ok: true, text, usage };
}
