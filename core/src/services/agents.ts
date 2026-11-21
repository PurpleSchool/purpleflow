// Запуск агентов: роли конвейера и служебные вызовы, выбор агента и модели.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addUsage, type AgentResult } from '../agents/common.js';
import { prependPath } from '../env.js';
import { StopSignal } from '../runtime.js';
import type { Kernel } from '../kernel.js';
import type { AgentKind, Role, RunFile } from '../types.js';
import { AGENT_KINDS, DEFAULT_AGENTS, effortFor, enabledAgents } from '../types.js';
import { knowledgeBlock, relatedRepos } from './projects.js';
import { workDir } from './repos.js';

type ServiceOptions = {
  prompt: string;
  group: string;
  /** Run-owned background work: prevents a spawn after Stop/Delete invalidated this call. */
  owner?: { id: string; token: number };
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  tools?: string[];
  /** Модель для агента из agent (или для служебного агента, если agent не задан). */
  model?: string;
  addDirs?: string[];
  idleTimeoutMs?: number;
  userConfig?: boolean;
  onOutput?: (t: string) => void;
  /** Агент, выбранный в настройках (менеджер, сканирование, проверка окружения); если его нет на машине — как у служебных вызовов. */
  agent?: AgentKind;
  /** Нужен браузер и запись вне рабочей копии (проверка окружения) — у codex песочница без ограничений. */
  fullAccess?: boolean;
  /**
   * Агент не справился (не вошёл, нет ключа, упал) — повторить на другом, если он установлен.
   * Остановку человеком и таймаут не повторяем: это не про настройку агента.
   */
  fallback?: boolean;
  /** Изображения от человека: codex получает их флагом, claude — путями, открывает инструментом Read. */
  images?: string[];
};

/**
 * Служебный вызов агента — сводка, уроки, карта плана, команды, режим, профиль, проверка окружения:
 * прокси, вход и модель из настроек в одном месте. По умолчанию без инструментов и во временной папке.
 */
export async function service(k: Kernel, o: ServiceOptions): Promise<AgentResult> {
  checkOwner(k, o);
  const agent = o.agent && (await k.hasTool(o.agent)) ? o.agent : await serviceAgent(k);
  checkOwner(k, o);
  // Имя модели одного CLI другому не подходит: своя модель — только тому агенту, для которого её выбрали.
  const ownModel = !o.agent || o.agent === agent ? o.model : undefined;
  const res = await serviceOn(k, agent, ownModel, o);
  if (res.ok || res.stopped || res.timedOut || !o.fallback) return res;
  const other = await otherAgent(k, agent);
  checkOwner(k, o);
  if (!other) return res;
  o.onOutput?.(`\n${agent} не справился (${res.error ?? 'без ответа'}) — пробую ${other}…\n`);
  const second = await serviceOn(k, other, undefined, o);
  const usage = addUsage(res.usage, second.usage);
  if (second.ok) return { ...second, usage };
  return { ...second, usage, error: `${res.error ?? `${agent}: без ответа`}; ${second.error ?? `${other}: без ответа`}` };
}

async function serviceOn(k: Kernel, agent: AgentKind, model: string | undefined, o: ServiceOptions): Promise<AgentResult> {
  checkOwner(k, o);
  const s = k.opts.getSettings();
  const tools = await k.tools([agent]);
  checkOwner(k, o);
  const common = {
    bin: tools[agent],
    cwd: o.cwd ?? os.tmpdir(),
    env: o.env ?? k.opts.env,
    prompt: o.prompt,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    group: o.group,
    onOutput: o.onOutput ?? (() => {}),
    proxy: s.proxy.baseUrl ? s.proxy : undefined,
    userConfig: o.userConfig,
  };
  const images = o.images?.filter((f) => fs.existsSync(f)) ?? [];
  if (agent === 'opencode') {
    // Служебное на opencode — без правки файлов; читать соседние каталоги ему можно и так.
    return k.opencode({
      ...common,
      shouldStop: o.owner ? () => !k.backgroundCurrent(o.owner!.id, o.owner!.token) : undefined,
      images: images.length ? images : undefined,
      model: model || agentModel(k, 'opencode', s.agents, s.models) || undefined,
      readOnly: !o.fullAccess,
    });
  }
  if (agent === 'codex') {
    // Служебное на codex — в песочнице только для чтения: соседние каталоги он читает и так, список инструментов не нужен.
    return k.codex({
      ...common,
      images: images.length ? images : undefined,
      model: model || agentModel(k, 'codex', s.agents, s.models) || undefined,
      sandbox: o.fullAccess ? 'danger-full-access' : 'read-only',
    });
  }
  // claude не принимает изображения флагом — даём пути и доступ к их папке; без Read он их не откроет.
  const dirs = [...new Set([...(o.addDirs ?? []), ...images.map((f) => path.dirname(f))])];
  const allowed = o.tools ?? [];
  return k.claude({
    ...common,
    prompt: images.length
      ? `${o.prompt}\n\nИзображения от человека (открой инструментом Read):\n${images.map((f) => `- ${f}`).join('\n')}`
      : o.prompt,
    claudeAuth: s.claudeAuth,
    model: model || claudeModel(k, s.agents, s.models) || undefined,
    addDirs: dirs.length ? dirs : undefined,
    tools: images.length && !allowed.includes('Read') ? [...allowed, 'Read'] : allowed,
  });
}

function checkOwner(k: Kernel, o: ServiceOptions) {
  if (o.owner && !k.backgroundCurrent(o.owner.id, o.owner.token)) throw new StopSignal();
}

/** Кто выполняет служебные вызовы (сводка, профиль, уроки, менеджер): claude, за ним codex, затем opencode — первый включённый и найденный. */
export async function serviceAgent(k: Kernel): Promise<AgentKind> {
  for (const a of AGENT_KINDS) if (await k.hasTool(a)) return a;
  const on = enabledAgents(k.opts.getSettings());
  throw new Error(
    on.length === 1 ? `Не найден ${on[0]}. Укажите путь в настройках.` : `Не найдены ни ${on.join(', ни ')}. Укажите пути в настройках.`,
  );
}

/** Запасной агент, если этот не справился: следующий включённый и найденный. */
async function otherAgent(k: Kernel, agent: AgentKind): Promise<AgentKind | null> {
  for (const a of AGENT_KINDS) if (a !== agent && (await k.hasTool(a))) return a;
  return null;
}

/** Модель первой роли, которую выполняет этот агент. */
export function agentModel(
  k: Kernel,
  agent: AgentKind,
  agents: Partial<Record<Role, AgentKind>> | undefined,
  models: Record<Role, string>,
): string {
  const a = { ...DEFAULT_AGENTS, ...agents };
  // Роль без своей модели пропускаем: иначе пустое поле исполнителя спрятало бы модель ревьюера на том же агенте.
  const role = (['executor', 'planner', 'reviewer'] as Role[]).find((r) => a[r] === agent && models[r]?.trim());
  return role ? models[role] : '';
}

/** Модель для служебных запусков claude: модель исполнителя или планировщика, если эту роль выполняет claude. */
export function claudeModel(k: Kernel, agents: Partial<Record<Role, AgentKind>> | undefined, models: Record<Role, string>): string {
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
  k: Kernel,
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
    /** Продолжить сессию: claude — по своему ID, opencode — по ID, который он выдал (onSession). */
    resume?: string;
    /** opencode: ID сессии, которую он завёл, — чтобы продолжить её в следующей попытке. */
    onSession?: (id: string) => void;
    /** Свой приёмник вывода (параллельное ревью копит вывод, чтобы не перемешать лог с проверками). */
    onOutput?: (text: string) => void;
  },
): Promise<AgentResult> {
  const agent = run.agents[role];
  const tools = await k.tools(o.openspec ? [agent, 'openspec'] : [agent]);
  const base = {
    ...agentBase(k, run, tools[agent], o.openspec ? tools.openspec : undefined),
    ...(o.onOutput ? { onOutput: o.onOutput } : {}),
  };
  const model = run.models[role] || undefined;
  const effort = effortFor(agent, run.efforts?.[role]);
  // Знания о проекте (профиль и уроки) — всем ролям; в продолжении сессии они уже в контексте.
  const systemPrompt = o.resume ? o.systemPrompt : `${o.systemPrompt ?? ''}${knowledgeBlock(k, run)}` || undefined;
  if (agent === 'opencode') {
    // Схему ответа opencode не принимает: формат JSON задаёт промпт, ответ разбирает parse.ts.
    return k.opencode({
      ...base,
      prompt: o.prompt,
      // В продолжении системный промпт уже в начале сессии: opencode дописал бы его в сообщение ещё раз.
      systemPrompt: o.resume ? undefined : systemPrompt,
      model,
      effort,
      readOnly: o.readOnly,
      images: o.images,
      resumeSession: o.resume,
      onSession: o.onSession,
    });
  }
  if (agent === 'codex') {
    return k.codex({
      ...base,
      prompt: o.prompt,
      systemPrompt,
      model,
      effort,
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
  return k.claude({
    ...base,
    prompt,
    systemPrompt,
    model,
    effort,
    addDirs: dirs.length ? dirs : undefined,
    sessionId: o.sessionId,
    resume: o.resume,
  });
}

export function agentBase(k: Kernel, run: RunFile, bin: string, openspecBin?: string) {
  const s = k.opts.getSettings();
  // Агенту нужен тот же openspec, что и ядру.
  const env = openspecBin ? prependPath(k.opts.env, path.dirname(openspecBin)) : k.opts.env;
  return {
    bin,
    cwd: workDir(run),
    env,
    // Агента не обрываем за долгую работу: останавливаем, только если он молчит agentTimeoutMin (завис),
    // или по жёсткому потолку ×4. О долгой работе человеку подсказывает окно прогона.
    timeoutMs: Math.max(1, s.agentTimeoutMin) * 4 * 60_000,
    idleTimeoutMs: Math.max(1, s.agentTimeoutMin) * 60_000,
    group: run.id,
    onOutput: (text: string) => k.log(run, text, false),
    proxy: s.proxy.baseUrl ? s.proxy : undefined,
    claudeAuth: s.claudeAuth,
    userConfig: s.userConfig ?? true,
    addDirs: agentDirs(k, run),
  };
}

/** Каталоги, которые агент видит помимо рабочей копии: вложения задачи и соседние репозитории (только чтение). */
export function agentDirs(k: Kernel, run: RunFile): string[] | undefined {
  const dirs = [
    ...(run.attachments?.length ? [path.dirname(run.attachments[0])] : []),
    ...relatedRepos(k, run.projectPath).map((r) => r.path),
    // Папка проекта из нескольких репозиториев: неотмеченные репозитории и файлы в её корне — для чтения.
    ...(run.root ? [run.root.path] : []),
  ];
  return dirs.length ? dirs : undefined;
}
