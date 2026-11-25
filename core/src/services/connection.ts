// Проверка подключения агентов с текущими настройками прокси и моделей.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAnsi } from '../agents/common.js';
import { opencodeMajor } from '../agents/opencode.js';
import { detectTools, prependPath } from '../env.js';
import { run } from '../proc.js';
import type { Kernel } from '../kernel.js';
import type { AgentKind, ConnectionCheck, Role } from '../types.js';
import { DEFAULT_AGENTS, enabledAgents } from '../types.js';

/** Тестовый запрос каждым агентом с текущими настройками прокси и моделей. */
export async function testConnection(k: Kernel): Promise<ConnectionCheck[]> {
  const s = k.opts.getSettings();
  const found = await detectTools(k.opts.env, s.toolPaths);
  const present = enabledAgents(s).filter((a) => found[a].path && !found[a].error);
  if (!present.length) {
    const on = enabledAgents(s);
    throw new Error(
      on.length === 1 ? `Не найден ${on[0]}. Укажите путь в настройках.` : 'Не найдены ни claude, ни codex. Укажите пути в настройках.',
    );
  }
  const tools: Record<AgentKind, string> = { claude: found.claude.path!, codex: found.codex.path!, opencode: found.opencode.path! };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-check-'));
  const proxy = s.proxy.baseUrl ? s.proxy : undefined;
  const prompt = 'Это проверка подключения. Ответь ровно одним словом: готово';
  const one = async (agent: AgentKind): Promise<ConnectionCheck> => {
    const t0 = Date.now();
    // Модель — из первой роли, которую выполняет этот агент.
    const agents = { ...DEFAULT_AGENTS, ...s.agents };
    const role = (['planner', 'executor', 'reviewer'] as Role[]).find((x) => agents[x] === agent);
    const model = role ? s.models[role] : '';
    const base = {
      bin: tools[agent],
      cwd: dir,
      env: k.opts.env,
      prompt,
      model,
      timeoutMs: 120_000,
      group: `check-${agent}`,
      onOutput: () => {},
      proxy,
      claudeAuth: s.claudeAuth,
    };
    const r =
      agent === 'claude'
        ? await k.claude(base)
        : agent === 'opencode'
          ? await k.opencode({ ...base, readOnly: true })
          : await k.codex({ ...base, sandbox: 'read-only' });
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
    removeLater(dir);
  }
}

/**
 * Убрать временную папку проверки, не роняя саму проверку. На Windows папку держит процесс, для которого она текущая:
 * агент, его фоновый сервер (opencode 2) — и rmdir отвечает EPERM, пока он не выйдет. Пробуем сразу, потом ещё раз позже;
 * не вышло — папка остаётся во временном каталоге системы, это не ошибка подключения.
 */
export function removeLater(dir: string, delaysMs = [5_000, 30_000]): void {
  const attempt = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return true;
    } catch {
      return false;
    }
  };
  if (attempt()) return;
  const [next, ...rest] = delaysMs;
  if (next === undefined) return;
  setTimeout(() => removeLater(dir, rest), next).unref();
}

const modelsCache = new Map<string, { at: number; list: Promise<string[]> }>();

/**
 * Модели opencode: `opencode models` — провайдеры, которые пользователь подключил сам (opencode auth login, конфиг),
 * и бесплатные opencode/*. Список держим минуту: подсказки нужны на каждом экране моделей.
 * dir — папка проекта: тогда видны и провайдеры из его opencode.json. Без неё — из домашней папки.
 */
export async function listOpencodeModels(k: Kernel, dir?: string): Promise<string[]> {
  if (!(await k.hasTool('opencode'))) return [];
  const bin = (await k.tools(['opencode'])).opencode;
  const cwd = dir && fs.existsSync(dir) ? path.resolve(dir) : os.homedir();
  const key = `${bin}\0${cwd}`;
  const hit = modelsCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  for (const [x, v] of modelsCache) if (Date.now() - v.at >= 60_000) modelsCache.delete(x);
  const env = { ...prependPath(k.opts.env, path.dirname(bin)), PWD: cwd };
  // opencode 2 без --standalone поднял бы фоновый сервис и оставил его работать.
  const list = opencodeMajor(bin, env)
    .then((major) => run(bin, major >= 2 ? ['models', '--standalone'] : ['models'], { cwd, env, timeoutMs: 30_000 }))
    .then((r) =>
      r.code === 0
        ? [
            ...new Set(
              stripAnsi(r.stdout)
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => /^[\w.-]+\/\S+$/.test(l)),
            ),
          ]
        : [],
    );
  modelsCache.set(key, { at: Date.now(), list });
  list.catch(() => modelsCache.delete(key));
  return list;
}
