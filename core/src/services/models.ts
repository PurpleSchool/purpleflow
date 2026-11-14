import os from 'node:os';
import path from 'node:path';
import { openCodeEnv } from '../agents/opencode.js';
import type { Kernel } from '../kernel.js';
import { run } from '../proc.js';

/** CLI возвращает provider/model построчно; model может содержать дополнительные слеши и двоеточия. */
export function parseOpenCodeModels(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((id) => /^[\w.-]+\/[^\s]+$/.test(id)),
    ),
  ];
}

const cache = new WeakMap<Kernel, Map<string, { until: number; result: Promise<string[]> }>>();

/** Каталог берётся у самого CLI: учитывает провайдеров и конфигурацию выбранного проекта. */
export async function openCodeModels(k: Kernel, directory?: string): Promise<string[]> {
  const cwd = directory ? path.resolve(directory) : os.homedir();
  const key = JSON.stringify([cwd, k.opts.getSettings().toolPaths.opencode]);
  let entries = cache.get(k);
  if (!entries) cache.set(k, (entries = new Map()));
  const old = entries.get(key);
  if (old && old.until > Date.now()) return old.result;
  for (const [key, entry] of entries) if (entry.until <= Date.now()) entries.delete(key);
  const result = (async () => {
    const tools = await k.tools(['opencode']);
    const r = await run(tools.opencode, ['--standalone', 'models'], {
      cwd,
      env: openCodeEnv({ env: k.opts.env, cwd }),
      timeoutMs: 30_000,
      group: 'opencode-models',
    });
    if (r.code !== 0 || r.timedOut || r.killed || r.spawnError)
      throw new Error(r.spawnError || r.stderr.trim().slice(0, 500) || 'Не удалось загрузить модели OpenCode');
    return parseOpenCodeModels(r.stdout);
  })();
  // Ошибки не кэшируем: следующий вход на экран или возврат фокуса повторит запрос.
  const entry = { until: Date.now() + 60_000, result };
  entries.set(key, entry);
  void result.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return result;
}
