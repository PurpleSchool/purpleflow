// Упоминания в чате: @файл проекта и /скилл (или команда) из настроек проекта и пользователя.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatSkill } from '../types.js';

/** Больше файлов в подсказке не нужно: человек всё равно сужает список, набирая имя. */
const MAX_FILES = 20_000;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'target',
  'coverage',
]);

/** Файлы папки без git: обход в ширину без тяжёлых служебных каталогов. */
export function walkFiles(root: string, max = MAX_FILES): string[] {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < max) {
    const rel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(p);
      } else if (e.isFile()) {
        out.push(p);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/** Описание из frontmatter (description:) или первая строка текста. */
function describe(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 4000);
  } catch {
    return undefined;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const d = /^description:\s*(.+)$/m
      .exec(fm[1])?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '');
    if (d) return d.slice(0, 200);
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const line = body
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return line?.slice(0, 200);
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const subdirs = (dir: string) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(dir, e.name));

/**
 * Скиллы: каталоги с SKILL.md. Каталог без SKILL.md смотрим глубже (до трёх уровней) —
 * так лежат скиллы, синхронизированные с claude.ai: ~/.claude/skills/synced/<id>/<скилл>/SKILL.md.
 */
function skillsIn(dir: string, source: ChatSkill['source'], prefix = '', depth = 3): ChatSkill[] {
  if (!isDir(dir)) return [];
  const out: ChatSkill[] = [];
  for (const d of subdirs(dir)) {
    const f = path.join(d, 'SKILL.md');
    if (fs.existsSync(f)) out.push({ name: prefix + path.basename(d), description: describe(f), path: f, source });
    else if (depth > 1) out.push(...skillsIn(d, source, prefix, depth - 1));
  }
  return out;
}

/** Установленные плагины claude: их скиллы и команды вызываются как «плагин:имя». */
function pluginSkills(home: string): ChatSkill[] {
  let data: { plugins?: Record<string, unknown> };
  try {
    data = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return [];
  }
  const out: ChatSkill[] = [];
  for (const [key, val] of Object.entries(data.plugins ?? {})) {
    const name = key.split('@')[0];
    const installs = (Array.isArray(val) ? val : [val]) as { installPath?: unknown }[];
    const dir = installs.map((i) => i?.installPath).find((p): p is string => typeof p === 'string');
    if (!dir) continue;
    out.push(...skillsIn(path.join(dir, 'skills'), 'user', `${name}:`));
    out.push(...commandsIn(path.join(dir, 'commands'), 'user').map((c) => ({ ...c, name: `${name}:${c.name}` })));
  }
  return out;
}

/** Команды: .md-файлы, вложенные каталоги — через двоеточие (frontend/test.md → frontend:test), как в claude. */
function commandsIn(dir: string, source: ChatSkill['source']): ChatSkill[] {
  if (!isDir(dir)) return [];
  const out: ChatSkill[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const f = path.join(dir, p);
        out.push({ name: p.slice(0, -3).replace(/\//g, ':'), description: describe(f), path: f, source });
      }
    }
  };
  walk('');
  return out;
}

/**
 * Скиллы и команды для «/» в чате. Проектные — всегда; пользовательские (~/.claude, ~/.codex) — только если агенты
 * запускаются с настройками пользователя, иначе агент их не видит. При совпадении имён проектный важнее.
 */
export function listSkills(o: { projectPath?: string; userConfig: boolean; home?: string }): ChatSkill[] {
  const home = o.home ?? os.homedir();
  const all: ChatSkill[] = [];
  if (o.projectPath) {
    const p = o.projectPath;
    all.push(
      ...skillsIn(path.join(p, '.claude', 'skills'), 'project'),
      ...skillsIn(path.join(p, '.codex', 'skills'), 'project'),
      ...skillsIn(path.join(p, '.agents', 'skills'), 'project'),
      ...commandsIn(path.join(p, '.claude', 'commands'), 'project'),
    );
  }
  if (o.userConfig) {
    all.push(
      ...skillsIn(path.join(home, '.claude', 'skills'), 'user'),
      ...skillsIn(path.join(home, '.codex', 'skills'), 'user'),
      ...skillsIn(path.join(home, '.agents', 'skills'), 'user'),
      ...commandsIn(path.join(home, '.claude', 'commands'), 'user'),
      ...commandsIn(path.join(home, '.codex', 'prompts'), 'user'),
      ...pluginSkills(home),
    );
  }
  const seen = new Set<string>();
  return all.filter((s) => !seen.has(s.name) && seen.add(s.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** @путь в тексте: в начале или после пробела, путь — до пробела; знаки препинания в конце не входят. */
const MENTION = /(?:^|\s)@([^\s]+)/g;
/** /скилл: в начале или после пробела; имя — буквы, цифры, «-», «_», «:», «.». */
const SLASH = /(?:^|\s)\/([\w][\w:.-]*)/gu;

const trimTail = (s: string) => s.replace(/[.,;:!?)»"']+$/, '');

/**
 * Что упомянуто в сообщении: существующие файлы (абсолютные пути) и известные скиллы.
 * Агенту они уходят отдельным блоком промпта — так работает и claude, и codex, и без поддержки «@» и «/» в CLI.
 */
export function findMentions(text: string, cwd: string, skills: ChatSkill[]): { files: string[]; skills: ChatSkill[] } {
  const files = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const rel = trimTail(m[1]);
    if (!rel) continue;
    const abs = path.resolve(cwd, rel);
    // Только внутри рабочей папки или абсолютный путь, который человек написал сам.
    if ((abs.startsWith(cwd + path.sep) || path.isAbsolute(rel)) && fs.existsSync(abs)) files.add(abs);
  }
  const byName = new Map(skills.map((s) => [s.name, s]));
  const used = new Map<string, ChatSkill>();
  for (const m of text.matchAll(SLASH)) {
    const s = byName.get(trimTail(m[1]));
    if (s) used.set(s.name, s);
  }
  return { files: [...files], skills: [...used.values()] };
}

/** Блок промпта про упоминания; пусто — упоминаний нет. */
export function mentionsBlock(m: { files: string[]; skills: ChatSkill[] }): string {
  let s = '';
  if (m.files.length) s += `\n\nФайлы, которые упомянул человек (открой и прочитай):\n${m.files.map((f) => `- ${f}`).join('\n')}`;
  if (m.skills.length)
    s += `\n\nЧеловек вызвал ${m.skills.length > 1 ? 'скиллы' : 'скилл'} — прочитай инструкции и следуй им:\n${m.skills
      .map((k) => `- /${k.name}: ${k.path}`)
      .join('\n')}`;
  return s;
}
