import { run } from '../proc.js';
import { StopSignal } from '../runtime.js';
import { codexProxyBase } from './codex.js';
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
import { todosOf, toolName, toolView } from './tools.js';

export interface OpencodeOptions extends AgentRunOptions {
  /** Service ownership can expire while the CLI version is being detected. */
  shouldStop?: () => boolean;
  /** Стадия не меняет файлы (уточнение, ревью, служебное): правка файлов запрещена правами opencode. */
  readOnly?: boolean;
  /** Правки без полного доступа: shell без коммитов, пуша, переписывания истории и остановки процессов. */
  limited?: boolean;
  /** Продолжить сохранённую сессию: opencode run -s <id>. */
  resumeSession?: string;
}

const KEY_ENV = 'PURPLEFLOW_OPENAI_API_KEY';

/** Провайдер AI-прокси в конфиге opencode: модели без префикса провайдера идут через него. */
export const PROXY_PROVIDER = 'purpleflow';

/**
 * Модель AI-прокси, когда у роли своей нет: рабочая ступень линейки, как у исполнителя «Оптимального» пресета.
 * Без неё opencode взял бы модель из своих настроек — мимо прокси, на который человек подписан.
 */
export const PROXY_DEFAULT_MODEL = 'gpt-6.1-terra';

/** Имя модели в провайдере прокси: без провайдера — модель прокси (пусто — модель по умолчанию); с провайдером — не прокси. */
function proxyModelName(model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m) return PROXY_DEFAULT_MODEL;
  return m.includes('/') ? undefined : m;
}

/**
 * Модель для -m: у opencode она всегда «провайдер/модель». С AI-прокси имя без провайдера
 * (gpt-6-sol, как у codex) и пустое уходят в провайдер прокси; с префиксом — как есть, в провайдер пользователя.
 */
export function opencodeModel(model: string | undefined, proxy: AgentRunOptions['proxy']): string | undefined {
  if (proxy?.baseUrl) {
    const name = proxyModelName(model);
    if (name) return `${PROXY_PROVIDER}/${name}`;
  }
  return model?.trim() || undefined;
}

/**
 * Shell в стадиях только для чтения: git для диффа и истории, поиск, curl для вложений задачи (уточнение).
 * Остальное запрещено. Запись перенаправлением (`git log > файл`) шаблоны не ловят — как и у claude,
 * это запрещает промпт; песочницы, как у codex, у opencode нет.
 */
export const READ_ONLY_BASH: Record<string, 'allow' | 'deny'> = {
  '*': 'deny',
  ...Object.fromEntries(
    ['git status*', 'git diff*', 'git log*', 'git show*', 'git blame*', 'ls*', 'rg *', 'grep *', 'wc *', 'curl *'].map((p) => [p, 'allow']),
  ),
};

/**
 * Shell в правках чата без полного доступа. Песочницы у opencode нет — запрещаем по шаблонам то,
 * что у codex и claude закрывает песочница: запись в git и остановку процессов.
 */
export const LIMITED_BASH: Record<string, 'allow' | 'deny'> = {
  '*': 'allow',
  ...Object.fromEntries(
    [
      'git commit*',
      'git push*',
      'git reset*',
      'git checkout*',
      'git switch*',
      'git rebase*',
      'git merge*',
      'git tag*',
      'git branch -d*',
      'git branch -D*',
      'git stash*',
      'kill *',
      'pkill *',
      'killall *',
    ].map((p) => [p, 'deny']),
  ),
};

/**
 * Конфиг поверх настроек пользователя (OPENCODE_CONFIG_CONTENT): права только для чтения
 * и провайдер AI-прокси. Файлы конфигурации opencode PurpleFlow не меняет.
 */
export function opencodeConfig(o: Pick<OpencodeOptions, 'readOnly' | 'limited' | 'proxy' | 'model'>): string | undefined {
  const cfg: Record<string, unknown> = {};
  if (o.readOnly) cfg.permission = { edit: 'deny', bash: READ_ONLY_BASH };
  else if (o.limited) cfg.permission = { bash: LIMITED_BASH };
  if (o.proxy?.baseUrl) {
    const m = proxyModelName(o.model);
    cfg.provider = {
      [PROXY_PROVIDER]: {
        // Прокси PurpleSchool говорит на OpenAI Responses API — тот же адрес, что у codex.
        npm: '@ai-sdk/openai',
        name: 'PurpleSchool',
        options: { baseURL: codexProxyBase(o.proxy), apiKey: `{env:${KEY_ENV}}` },
        models: m ? { [m]: {} } : {},
      },
    };
  }
  return Object.keys(cfg).length ? JSON.stringify(cfg) : undefined;
}

/**
 * opencode run --format json; промпт — из stdin. --auto одобряет то, что не запрещено явно:
 * спросить человека в неинтерактивном запуске некому.
 */
export function opencodeArgs(
  o: Pick<OpencodeOptions, 'cwd' | 'model' | 'proxy' | 'images' | 'userConfig' | 'resumeSession'>,
  major = 1,
): string[] {
  // opencode 2: --dir и --pure убраны (папка — рабочая папка процесса и PWD); --standalone — свой сервер,
  // а не фоновый сервис: тот запущен раньше и не увидел бы OPENCODE_CONFIG_CONTENT (права «только чтение», прокси).
  const args = major >= 2 ? ['run', '--format', 'json', '--auto', '--standalone'] : ['run', '--format', 'json', '--auto', '--dir', o.cwd];
  // Без настроек пользователя — без его плагинов (MCP и agents из конфига opencode всё равно читает). В opencode 2 флага нет.
  if (!o.userConfig && major < 2) args.push('--pure');
  const model = opencodeModel(o.model, o.proxy);
  if (model) args.push('-m', model);
  if (o.resumeSession) args.push('-s', o.resumeSession);
  // --file=… по одному: многозначный -f иначе мог бы забрать и следующие аргументы.
  for (const img of o.images ?? []) args.push(`--file=${img}`);
  return args;
}

type Part = Record<string, unknown>;

const majors = new Map<string, Promise<number>>();

/**
 * Старшая версия opencode: у 2.x другие флаги run. Узнаём один раз на путь к программе;
 * не вышло — считаем 1.x, как было до второй версии.
 */
export function opencodeMajor(bin: string, env: NodeJS.ProcessEnv): Promise<number> {
  let hit = majors.get(bin);
  if (!hit) {
    hit = run(bin, ['--version'], { cwd: process.cwd(), env, timeoutMs: 15_000 }).then((r) => parseMajor(`${r.stdout}\n${r.stderr}`));
    majors.set(bin, hit);
  }
  return hit;
}

export function parseMajor(text: string): number {
  const m = /(\d+)\.\d+\.\d+/.exec(text);
  return m ? Number(m[1]) : 1;
}

/** Имена инструментов opencode → привычные по claude, чтобы чат показывал их так же. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  todowrite: 'TodoWrite',
};

/** Аргументы opencode → имена claude: файл, правка. */
function claudeInput(input: Part): Part {
  const out: Part = { ...input };
  if (input.filePath != null) out.file_path = input.filePath;
  if (input.oldString != null) out.old_string = input.oldString;
  if (input.newString != null) out.new_string = input.newString;
  return out;
}

/** Шаги чата по части ответа opencode: текст, размышления, вызов инструмента с итогом. */
export function opencodeSteps(ev: Record<string, unknown>): AgentStep[] {
  const part = (ev.part ?? {}) as Part;
  switch (ev.type) {
    case 'text':
      return String(part.text ?? '').trim() ? [{ kind: 'text', text: String(part.text).trim(), fresh: true }] : [];
    case 'reasoning':
      return String(part.text ?? '').trim() ? [{ kind: 'thinking', text: String(part.text).trim() }] : [];
    case 'tool_use': {
      const raw = String(part.tool ?? '?');
      const name = TOOL_NAMES[raw] ?? raw;
      const state = (part.state ?? {}) as Part;
      const input = claudeInput((state.input ?? {}) as Part);
      const todos = todosOf(name, input);
      if (todos) return [{ kind: 'todos', items: todos }];
      const id = typeof part.callID === 'string' ? part.callID : typeof part.id === 'string' ? part.id : undefined;
      const view = toolView(name, input);
      const steps: AgentStep[] = [defined({ kind: 'tool' as const, id, text: view.text || toolName(name), detail: view.detail })];
      if (id && (state.status === 'completed' || state.status === 'error')) {
        const output = String(state.status === 'error' ? (state.error ?? '') : (state.output ?? ''));
        steps.push(defined({ kind: 'tool_result', id, ok: state.status === 'completed', output: plainOutput(output) || undefined }));
      }
      return steps;
    }
    case 'error': {
      const msg = errorMessage(ev);
      return msg ? [{ kind: 'notice', level: 'warn', text: `opencode: ${msg}` }] : [];
    }
  }
  return [];
}

function errorMessage(ev: Record<string, unknown>): string {
  const e = (ev.error ?? {}) as { name?: string; message?: string; data?: { message?: string } };
  return String(e.data?.message ?? e.message ?? e.name ?? '').trim();
}

export async function runOpencode(o: OpencodeOptions): Promise<AgentResult> {
  const env = cleanEnv(o.env);
  const config = opencodeConfig(o);
  if (config) env.OPENCODE_CONFIG_CONTENT = config;
  else delete env.OPENCODE_CONFIG_CONTENT;
  if (o.proxy?.baseUrl) env[KEY_ENV] = o.proxy.apiKey;

  let usage = emptyUsage();
  /** Ответ — текст последнего шага, в котором он был: до него шли вызовы инструментов. */
  let stepText = '';
  let lastMessage = '';
  let session = '';
  const errors: string[] = [];
  const out = (s: string) => o.onOutput(crlf(s));
  const prompt = o.systemPrompt ? `${o.systemPrompt}\n\n---\n\n${o.prompt}` : o.prompt;
  const model = opencodeModel(o.model, o.proxy);
  const major = await opencodeMajor(o.bin, env);
  if (o.shouldStop?.()) throw new StopSignal();
  // opencode 2 берёт папку из PWD раньше, чем из рабочей папки процесса, — а PWD унаследован от приложения.
  env.PWD = o.cwd;

  const r = await run(o.bin, opencodeArgs(o, major), {
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
        if (line.trim()) out(c.dim(line) + '\n');
        return;
      }
      if (!session && typeof ev.sessionID === 'string') {
        session = ev.sessionID;
        out(c.dim(`● opencode · ${model || 'модель по умолчанию'}${o.readOnly ? ' · только чтение' : ''}`) + '\n');
        o.onSession?.(session);
      }
      const part = (ev.part ?? {}) as Part;
      switch (ev.type) {
        case 'step_start':
          stepText = '';
          break;
        case 'text': {
          const t = String(part.text ?? '');
          stepText = stepText ? `${stepText}\n\n${t}` : t;
          if (t.trim()) out(t.trim() + '\n');
          break;
        }
        case 'reasoning':
          if (part.text) out(c.dim(clip(String(part.text), 500)) + '\n');
          break;
        case 'tool_use': {
          const state = (part.state ?? {}) as Part;
          const name = TOOL_NAMES[String(part.tool)] ?? String(part.tool ?? '?');
          const { text } = toolView(name, claudeInput((state.input ?? {}) as Part));
          out(c.violet('▸ ') + text + '\n');
          if (state.status === 'error') out(c.coral(clip(String(state.error ?? ''), 400)) + '\n');
          break;
        }
        case 'step_finish': {
          if (stepText.trim()) lastMessage = stepText;
          const t = (part.tokens ?? {}) as {
            input?: number;
            output?: number;
            reasoning?: number;
            cache?: { read?: number; write?: number };
          };
          usage = addUsage(usage, {
            input: t.input ?? 0,
            output: (t.output ?? 0) + (t.reasoning ?? 0),
            cacheRead: t.cache?.read ?? 0,
            cacheWrite: t.cache?.write ?? 0,
            costUsd: typeof part.cost === 'number' ? part.cost : undefined,
          });
          break;
        }
        case 'error': {
          const msg = errorMessage(ev) || 'ошибка';
          errors.push(msg);
          out(c.coral(msg) + '\n');
          break;
        }
      }
      for (const st of opencodeSteps(ev)) o.onStep?.(st);
    },
  });

  const text = (lastMessage || stepText).trim();
  if (r.killed) return { ok: false, text, usage, stopped: true, error: 'Остановлено' };
  if (r.timedOut)
    return {
      ok: false,
      text,
      usage,
      timedOut: true,
      error: r.idle
        ? `opencode: молчал ${Math.round((o.idleTimeoutMs ?? 0) / 60000)} мин — похоже, завис; остановлен`
        : `opencode: превышен предельный таймаут ${Math.round(o.timeoutMs / 60000)} мин`,
    };
  if (r.spawnError) return { ok: false, text: '', usage, error: `opencode не запустился: ${r.spawnError}` };
  // Ошибку модели или провайдера opencode присылает событием и выходит с кодом 0.
  if (r.code !== 0 || (errors.length && !text)) {
    const raw = [...errors, r.stderr].join('\n') || `код выхода ${r.code}`;
    return { ok: false, text, usage, error: opencodeError(raw, model, Boolean(o.proxy?.baseUrl)) };
  }
  return { ok: true, text, usage };
}

/** Сбой opencode понятной фразой: свои провайдеры он подключает сам, поэтому и подсказки — про его вход и имя модели. */
export function opencodeError(raw: string, model: string | undefined, proxy: boolean): string {
  // Неизвестные провайдер или модель opencode отдаёт безликой «Unexpected server error».
  if (/unexpected server error|providermodelnotfound|provider.*not found/i.test(raw))
    return `opencode: модель ${model ? `«${model}» ` : ''}недоступна. Имя — «провайдер/модель» из списка opencode models; провайдер подключают командой opencode auth login.`;
  const text = explainError('opencode', raw, proxy ? 'proxy' : 'login');
  return proxy
    ? text
    : text.replace(/Выполните в терминале «opencode» и войдите в аккаунт/, 'Подключите провайдера командой opencode auth login');
}
