// Установка недостающих инструментов из окна. Имена пакетов зашиты здесь: окно передаёт только имя инструмента, а не команду.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTool, pathKey, prependPath, which } from '../env.js';
import { run } from '../proc.js';
import type { ToolInstallResult, ToolName } from '../types.js';

const NPM_PACKAGES: Partial<Record<ToolName, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  openspec: '@fission-ai/openspec',
};

const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** git ставится средствами ОС и просит подтверждения у пользователя: делать это молча нельзя. */
function gitHint(): string {
  if (process.platform === 'darwin') return 'Git ставится вместе с инструментами Xcode: выполните xcode-select --install в терминале.';
  if (process.platform === 'win32') return 'Установите Git с git-scm.com или командой winget install Git.Git.';
  return 'Установите Git через пакетный менеджер системы.';
}

/** Последние строки вывода: в начале npm пишет предупреждения, причина сбоя — в конце. */
const tail = (s: string) => s.trim().split('\n').slice(-3).join('\n').slice(-400);

export async function installTool(name: ToolName, env: NodeJS.ProcessEnv, manual?: string): Promise<ToolInstallResult> {
  const pkg = NPM_PACKAGES[name];
  if (!pkg) return { name, ok: false, error: name === 'git' ? gitHint() : `Неизвестный инструмент: ${name}` };
  // Установка не исправит чужой путь: окно продолжит запускать файл, указанный вручную.
  if (manual?.trim()) return { name, ok: false, error: 'Указан путь вручную. Очистите его, чтобы установить инструмент автоматически.' };
  const npm = which('npm', env);
  if (!npm) return { name, ok: false, error: 'Не найден npm. Установите Node.js с nodejs.org и повторите.' };

  const npmEnv = prependPath(env, path.dirname(npm));
  const install = (extra: string[] = []) =>
    run(npm, ['install', '--global', '--no-audit', '--no-fund', ...extra, pkg], {
      cwd: os.homedir(),
      env: npmEnv,
      timeoutMs: INSTALL_TIMEOUT_MS,
      group: 'tool-setup',
    });

  let r = await install();
  // Системный Node пишет в каталог root. sudo из окна не просим: ставим в домашний каталог, его PATH дополняется в env.ts.
  if (r.code !== 0 && process.platform !== 'win32' && /EACCES|EPERM/.test(r.stderr)) {
    const prefix = path.join(os.homedir(), '.npm-global');
    fs.mkdirSync(prefix, { recursive: true });
    r = await install(['--prefix', prefix]);
    if (r.code === 0) env[pathKey(env)] = prependPath(env, path.join(prefix, 'bin'))[pathKey(env)];
  }
  if (r.spawnError || r.timedOut || r.code !== 0) {
    const why = r.timedOut ? 'Установка не уложилась в 5 минут' : r.spawnError || tail(r.stderr || r.stdout) || `код ${r.code}`;
    return { name, ok: false, error: `Не удалось установить ${pkg}: ${why}` };
  }

  const info = await detectTool(name, env);
  if (!info.path) return { name, ok: false, info, error: `${pkg} установлен, но ${name} не найден в PATH.` };
  if (info.error) return { name, ok: false, info, error: info.error };
  return { name, ok: true, info };
}
