// Запуск агентов: роли конвейера и служебные вызовы, выбор агента и модели.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AgentResult } from '../agents/common.js';
import { prependPath } from '../env.js';
import type { Kernel } from '../kernel.js';
import type { AgentKind, Role, RunFile } from '../types.js';
import { DEFAULT_AGENTS } from '../types.js';
import { knowledgeBlock, relatedRepos } from './projects.js';

/**
 * Служебный вызов claude — сводка, уроки, карта плана, команды, режим, профиль, проверка окружения:
 * прокси, вход и модель из настроек в одном месте. По умолчанию без инструментов и во временной папке.
 */
export async function service(
  h: Kernel,
  o: {
    prompt: string;
    group: string;
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    tools?: string[];
    model?: string;
    addDirs?: string[];
    idleTimeoutMs?: number;
    userConfig?: boolean;
    onOutput?: (t: string) => void;
    /** Агент, выбранный в настройках (менеджер, проверка окружения); если его нет на машине — как у служебных вызовов. */
    agent?: AgentKind;
    /** Нужен браузер и запись вне рабочей копии (проверка окружения) — у codex песочница без ограничений. */
    fullAccess?: boolean;
  },
): Promise<AgentResult> {
  const s = h.opts.getSettings();
  const agent = o.agent && (await h.hasTool(o.agent)) ? o.agent : await serviceAgent(h);
  const tools = await h.tools([agent]);
  const common = {
    bin: tools[agent],
    cwd: o.cwd ?? os.tmpdir(),
    env: o.env ?? h.opts.env,
    prompt: o.prompt,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    group: o.group,
    onOutput: o.onOutput ?? (() => {}),
    proxy: s.proxy.baseUrl ? s.proxy : undefined,
    userConfig: o.userConfig,
  };
  if (agent === 'codex') {
    // Без claude служебное — на codex в песочнице только для чтения: соседние каталоги он читает и так, список инструментов не нужен.
    return h.codex({
      ...common,
      model: o.model || agentModel(h, 'codex', s.agents, s.models) || undefined,
      sandbox: o.fullAccess ? 'danger-full-access' : 'read-only',
    });
  }
  return h.claude({
    ...common,
    claudeAuth: s.claudeAuth,
    model: o.model || claudeModel(h, s.agents, s.models) || undefined,
    addDirs: o.addDirs,
    tools: o.tools ?? [],
  });
}

/** Кто выполняет служебные вызовы (сводка, профиль, уроки, менеджер): claude, а если его нет — codex. */
export async function serviceAgent(h: Kernel): Promise<AgentKind> {
  if (await h.hasTool('claude')) return 'claude';
  if (await h.hasTool('codex')) return 'codex';
  throw new Error('Не найдены ни claude, ни codex. Укажите пути в настройках.');
}

/** Модель первой роли, которую выполняет этот агент. */
export function agentModel(
  h: Kernel,
  agent: AgentKind,
  agents: Partial<Record<Role, AgentKind>> | undefined,
  models: Record<Role, string>,
): string {
  const a = { ...DEFAULT_AGENTS, ...agents };
  const role = (['executor', 'planner', 'reviewer'] as Role[]).find((r) => a[r] === agent);
  return role ? models[role] : '';
}

/** Модель для служебных запусков claude: модель исполнителя или планировщика, если эту роль выполняет claude. */
export function claudeModel(h: Kernel, agents: Partial<Record<Role, AgentKind>> | undefined, models: Record<Role, string>): string {
  const a = { ...DEFAULT_AGENTS, ...agents };
  if (a.executor === 'claude') return models.executor;
  if (a.planner === 'claude') return models.planner;
  return '';
}

/**
 * Запуск агента роли: claude или codex — как выбрано в настройках на момент старта прогона.
 * readOnly — стадия не меняет файлы (уточнение, ревью): у claude это требование промпта, инструменты не ограничены; у codex — песочница read-only.
 */
export async function runRole(
  h: Kernel,
  run: RunFile,
  role: Role,
  o: {
    prompt: string;
    systemPrompt?: string;
    openspec?: boolean;
    readOnly?: boolean;
    images?: string[];
    outputSchema?: object;
    sessionId?: string;
    resume?: string;
    /** Свой приёмник вывода (параллельное ревью копит вывод, чтобы не перемешать лог с проверками). */
    onOutput?: (text: string) => void;
  },
): Promise<AgentResult> {
  const agent = run.agents[role];
  const tools = await h.tools(o.openspec ? [agent, 'openspec'] : [agent]);
  const base = {
    ...agentBase(h, run, tools[agent], o.openspec ? tools.openspec : undefined),
    ...(o.onOutput ? { onOutput: o.onOutput } : {}),
  };
  const model = run.models[role] || undefined;
  // Знания о проекте (профиль и уроки) — всем ролям; в продолжении сессии они уже в контексте.
  const systemPrompt = o.resume ? o.systemPrompt : `${o.systemPrompt ?? ''}${knowledgeBlock(h, run)}` || undefined;
  if (agent === 'codex') {
    return h.codex({
      ...base,
      prompt: o.prompt,
      systemPrompt,
      model,
      sandbox: o.readOnly ? 'read-only' : 'workspace-write',
      images: o.images,
      outputSchema: o.outputSchema,
    });
  }
  // claude не принимает изображения флагом — даём пути, он откроет их инструментом Read.
  const images = o.images?.filter((f) => fs.existsSync(f)) ?? [];
  const prompt = images.length
    ? `${o.prompt}\n\nИзображения (открой инструментом Read):\n${images.map((f) => `- ${f}`).join('\n')}`
    : o.prompt;
  const dirs = [...new Set([...(base.addDirs ?? []), ...images.map((f) => path.dirname(f))])];
  return h.claude({
    ...base,
    prompt,
    systemPrompt,
    model,
    addDirs: dirs.length ? dirs : undefined,
    sessionId: o.sessionId,
    resume: o.resume,
  });
}

export function agentBase(h: Kernel, run: RunFile, bin: string, openspecBin?: string) {
  const s = h.opts.getSettings();
  // Агенту нужен тот же openspec, что и ядру.
  const env = openspecBin ? prependPath(h.opts.env, path.dirname(openspecBin)) : h.opts.env;
  return {
    bin,
    cwd: run.worktreePath,
    env,
    // Агента не обрываем за долгую работу: останавливаем, только если он молчит agentTimeoutMin (завис),
    // или по жёсткому потолку ×4. О долгой работе человеку подсказывает окно прогона.
    timeoutMs: Math.max(1, s.agentTimeoutMin) * 4 * 60_000,
    idleTimeoutMs: Math.max(1, s.agentTimeoutMin) * 60_000,
    group: run.id,
    onOutput: (text: string) => h.log(run, text, false),
    proxy: s.proxy.baseUrl ? s.proxy : undefined,
    claudeAuth: s.claudeAuth,
    userConfig: s.userConfig ?? true,
    addDirs: agentDirs(h, run),
  };
}

/** Каталоги, которые агент видит помимо рабочей копии: вложения задачи и соседние репозитории (только чтение). */
export function agentDirs(h: Kernel, run: RunFile): string[] | undefined {
  const dirs = [
    ...(run.attachments?.length ? [path.dirname(run.attachments[0])] : []),
    ...relatedRepos(h, run.projectPath).map((r) => r.path),
  ];
  return dirs.length ? dirs : undefined;
}
