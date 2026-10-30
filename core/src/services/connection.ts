// Проверка подключения агентов с текущими настройками прокси и моделей.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTools } from '../env.js';
import type { Kernel } from '../kernel.js';
import type { ConnectionCheck, Role } from '../types.js';
import { DEFAULT_AGENTS } from '../types.js';

/** Тестовый запрос каждым агентом с текущими настройками прокси и моделей. */
export async function testConnection(h: Kernel): Promise<ConnectionCheck[]> {
  const s = h.opts.getSettings();
  const found = await detectTools(h.opts.env, s.toolPaths);
  const present = (['claude', 'codex'] as const).filter((a) => found[a].path && !found[a].error);
  if (!present.length) throw new Error('Не найдены ни claude, ни codex. Укажите пути в настройках.');
  const tools = { claude: found.claude.path!, codex: found.codex.path! };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-check-'));
  const proxy = s.proxy.baseUrl ? s.proxy : undefined;
  const prompt = 'Это проверка подключения. Ответь ровно одним словом: готово';
  const one = async (agent: 'claude' | 'codex'): Promise<ConnectionCheck> => {
    const t0 = Date.now();
    // Модель — из первой роли, которую выполняет этот агент.
    const agents = { ...DEFAULT_AGENTS, ...s.agents };
    const role = (['planner', 'executor', 'reviewer'] as Role[]).find((x) => agents[x] === agent);
    const model = role ? s.models[role] : '';
    const base = {
      bin: tools[agent],
      cwd: dir,
      env: h.opts.env,
      prompt,
      model,
      timeoutMs: 120_000,
      group: `check-${agent}`,
      onOutput: () => {},
      proxy,
      claudeAuth: s.claudeAuth,
    };
    const r = agent === 'claude' ? await h.claude(base) : await h.codex({ ...base, sandbox: 'read-only' });
    return {
      agent,
      ok: r.ok,
      model: model || 'по умолчанию',
      durationMs: Date.now() - t0,
      reply: r.text.trim().slice(0, 200),
      error: r.error,
    };
  };
  try {
    return await Promise.all(present.map(one));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
