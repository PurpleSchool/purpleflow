import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './proc.js';
import type { ToolInfo, ToolName } from './types.js';

const isWin = process.platform === 'win32';
const MARK = '__PURPLEFLOW_ENV__';

/**
 * Приложение, запущенное из Finder/Dock, получает урезанный PATH (/usr/bin:/bin…).
 * Берём окружение login+interactive шелла пользователя — так же, как это делают shell-env/fix-path.
 */
export function loadLoginShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (isWin) return stripSessionEnv({ ...base });
  const shell = base.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  // Шелл стартует с минимальным окружением — как при запуске из Finder. Иначе приложение,
  // запущенное из чужого терминала (например, из сессии Claude Code), унаследует её ключи и токены.
  const clean: NodeJS.ProcessEnv = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) {
    if (base[k]) clean[k] = base[k];
  }
  clean.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  clean.TERM = 'xterm-256color';
  try {
    const r = spawnSync(shell, ['-ilc', `printf '${MARK}'; env; printf '${MARK}'`], {
      encoding: 'utf8',
      timeout: 8000,
      env: { ...clean, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = r.stdout ?? '';
    const parts = out.split(MARK);
    if (parts.length < 3) return withExtraPath(stripSessionEnv({ ...base }));
    const env: NodeJS.ProcessEnv = { ...clean };
    for (const line of parts[1].split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    return withExtraPath(env);
  } catch {
    return withExtraPath(stripSessionEnv({ ...base }));
  }
}

/**
 * Запасной путь, если шелл не отработал: убрать переменные родительской сессии Claude Code
 * (её ключ и адрес работают только внутри той сессии и быстро протухают).
 */
export function stripSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inSession = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID);
  for (const k of Object.keys(env)) {
    if (
      k === 'CLAUDECODE' ||
      k === 'CLAUDE_AGENT_SDK_VERSION' ||
      k === 'CLAUDE_PID' ||
      k === 'CLAUDE_EFFORT' ||
      k.startsWith('CLAUDE_PREVIEW_')
    )
      delete env[k];
    else if (k.startsWith('CLAUDE_CODE_') && !/^CLAUDE_CODE_USE_/.test(k)) delete env[k];
  }
  if (inSession) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

/** Типичные места установки CLI, если их нет в PATH. */
function extraDirs(): string[] {
  const h = os.homedir();
  if (isWin) {
    const appData = process.env.APPDATA ?? path.join(h, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? path.join(h, 'AppData', 'Local');
    return [
      path.join(appData, 'npm'),
      path.join(h, '.local', 'bin'),
      path.join(h, '.bun', 'bin'),
      path.join(local, 'Programs', 'Git', 'cmd'),
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\nodejs',
    ];
  }
  return [
    path.join(h, '.local', 'bin'),
    path.join(h, '.bun', 'bin'),
    path.join(h, '.npm-global', 'bin'),
    path.join(h, '.volta', 'bin'),
    path.join(h, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

function withExtraPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = pathKey(env);
  const cur = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  for (const d of extraDirs()) if (!cur.includes(d) && fs.existsSync(d)) cur.push(d);
  env[key] = cur.join(path.delimiter);
  return env;
}

export function pathKey(env: NodeJS.ProcessEnv): string {
  if (!isWin) return 'PATH';
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
}

/** Аналог `which`: учитывает PATHEXT на Windows (claude.cmd, codex.cmd…). */
export function which(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env[pathKey(env)] ?? '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) {
          if (!isWin) fs.accessSync(p, fs.constants.X_OK);
          return p;
        }
      } catch {
        /* дальше */
      }
    }
  }
  return null;
}

/** Добавить каталог в начало PATH (чтобы агенты видели тот же openspec, что и ядро). */
export function prependPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = pathKey(env);
  const cur = (env[key] ?? '').split(path.delimiter).filter((d) => d && d !== dir);
  return { ...env, [key]: [dir, ...cur].join(path.delimiter) };
}

const VERSION_ARGS: Record<ToolName, string[]> = {
  git: ['--version'],
  claude: ['--version'],
  codex: ['--version'],
  openspec: ['--version'],
};

export async function detectTool(name: ToolName, env: NodeJS.ProcessEnv, manual?: string): Promise<ToolInfo> {
  const p = manual?.trim() ? manual.trim() : which(name, env);
  if (!p) return { name, path: null, version: null, error: 'Не найден в PATH' };
  if (manual?.trim() && !fs.existsSync(p)) return { name, path: p, version: null, error: 'Файл не существует' };
  // Для node-скриптов (shebang) нужен node в PATH — добавляем каталог самого инструмента.
  const r = await run(p, VERSION_ARGS[name], { cwd: os.homedir(), env: prependPath(env, path.dirname(p)), timeoutMs: 15_000 });
  if (r.spawnError || r.code !== 0) {
    return { name, path: p, version: null, error: (r.spawnError || r.stderr || `код ${r.code}`).trim().slice(0, 300) };
  }
  const line = (r.stdout || r.stderr).trim().split('\n')[0] ?? '';
  const m = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?/);
  return { name, path: p, version: m ? m[0] : line };
}

export async function detectTools(
  env: NodeJS.ProcessEnv,
  manual: Partial<Record<ToolName, string>> = {},
): Promise<Record<ToolName, ToolInfo>> {
  const names: ToolName[] = ['git', 'claude', 'codex', 'openspec'];
  const list = await Promise.all(names.map((n) => detectTool(n, env, manual[n])));
  return Object.fromEntries(list.map((t) => [t.name, t])) as Record<ToolName, ToolInfo>;
}
