import type { runClaude } from './agents/claude.js';
import type { runCodex } from './agents/codex.js';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseJsonReply } from './json.js';
import type { ClarifyQuestion, CoreEvent, CoreSettings, ReviewItem, StageId } from './types.js';
export interface CoreOptions {
  dataDir: string;
  promptsDir: string;
  /** Окружение login-шелла пользователя (см. loadLoginShellEnv). */
  env: NodeJS.ProcessEnv;
  getSettings: () => CoreSettings;
  /** Подмена агентов — для тестов конвейера без настоящих claude и codex. */
  runners?: { claude?: typeof runClaude; codex?: typeof runCodex };
}

export const IMPL_LIMIT = 3;
export const PLAN_RETRIES = 2;
export const MAX_TEST_OUTPUT = 12_000;
/** Дифф до такого размера кладётся в промпт ревьюера целиком, больше — списком файлов, ревьюер читает сам. */
export const INLINE_DIFF = 60_000;
export const RUN_JSON_GLOB = 'openspec/changes/**/run.json';

export const STAGE_TITLES: Record<StageId, string> = {
  clarify: 'Уточнение',
  gate0: 'Ответы на вопросы',
  plan: 'План',
  gate1: 'Утверждение плана',
  implement: 'Реализация',
  tests: 'Проверки',
  baseline: 'Базовые проверки',
  visual: 'Визуальная проверка',
  review: 'Ревью',
  gate2: 'Приёмка',
  limit: 'Нужно решение',
  finish: 'Завершение',
};

export type Listener = (e: CoreEvent) => void;

export interface Tools {
  git: string;
  claude: string;
  codex: string;
  openspec: string;
}

export class StopSignal extends Error {}

export function isGate(s: StageId): boolean {
  return s === 'gate0' || s === 'gate1' || s === 'gate2' || s === 'limit';
}

/** Название изменения от планировщика: первая строка proposal.md вида «# Название». */
export function planTitle(proposal: string): string | null {
  const m = proposal.match(/^\s*#\s+(.+?)\s*$/m);
  if (!m || /^(why|what changes|impact)$/i.test(m[1])) return null;
  const t = m[1]
    .replace(/^(change|изменение)\s*:\s*/i, '')
    .replace(/[`*]/g, '')
    .trim();
  return t ? (t.length > 72 ? t.slice(0, 70) + '…' : t) : null;
}

export const CHECK_NAME = { lint: 'линтер', test: 'тесты' } as const;

/** Свободный TCP-порт на localhost. */
/**
 * Число ошибок в выводе линтера или тестов — по итоговым строкам ESLint, tsc, Jest/Vitest, node:test, pytest, mocha, go.
 * null — если вывод не распознан.
 */
/**
 * Команда «выбранных тестов» из раздела «## Checks» proposal.md: только тесты, которых касается задача.
 * Их гоняют до правок и после каждой попытки, полный набор — один раз перед приёмкой. «нет» или пусто — не выбраны.
 */
export function parseFocusTests(proposal: string): string | undefined {
  const lines = proposal.split('\n');
  const start = lines.findIndex((l) => /^##\s+Checks\s*$/i.test(l.trim()));
  if (start < 0) return undefined;
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = l.match(/`([^`\n]+)`/);
    if (m) {
      const cmd = m[1].trim();
      return cmd && cmd.length <= 400 ? cmd : undefined;
    }
  }
  return undefined;
}

/** Пункты раздела «## Next Parts» из proposal.md — следующие части большой задачи. */
export function parseNextParts(proposal: string): string[] {
  const lines = proposal.split('\n');
  const start = lines.findIndex((l) => /^##\s+Next Parts\s*$/.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const item = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (item) out.push(item[1].trim());
    else if (l.trim() && out.length && /^\s{2,}/.test(l)) out[out.length - 1] += ' ' + l.trim();
  }
  return out;
}

export function parseVerdicts(text: string): { index: number; verdict: 'confirmed' | 'rejected' | 'minor'; reason: string }[] | null {
  {
    const j = parseJsonReply<{ items?: unknown }>(text);
    if (!j || !Array.isArray(j.items)) return null;
    return j.items
      .map((x) => x as { index?: unknown; verdict?: unknown; reason?: unknown })
      .filter((x) => typeof x.index === 'number' && ['confirmed', 'rejected', 'minor'].includes(String(x.verdict)))
      .map((x) => ({ index: x.index as number, verdict: x.verdict as 'confirmed' | 'rejected' | 'minor', reason: String(x.reason ?? '') }));
  }
}

/** Имена упавших тестов из вывода раннера (Jest, Vitest, pytest, go test, node:test); null — не распознали. */
export function failedTestNames(output: string): string[] | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const names = new Set<string>();
  for (const l of text.split('\n')) {
    const m =
      l.match(/^\s*● (.+?)\s*$/) ?? // Jest
      l.match(/^\s*(?:FAIL|×|✗)\s+(\S+\s+>\s+.+?)(?:\s+\d+m?s)?\s*$/) ?? // Vitest
      l.match(/^FAILED (\S+)/) ?? // pytest
      l.match(/^\s*--- FAIL: (\S+)/) ?? // go test
      l.match(/^\s*not ok \d+ - (.+?)\s*$/); // node:test, TAP
    if (m && !/^Console$/.test(m[1])) names.add(m[1]);
  }
  return names.size ? [...names] : null;
}

export function errorCount(output: string): number | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = [
    /✖\s*\d+\s+problems?\s*\((\d+)\s+errors?/g, // ESLint
    /Found (\d+) errors?/g, // tsc
    /Tests?:\s+(\d+) failed/g, // Jest, Vitest
    /^[ℹ#]\s*fail (\d+)/gm, // node:test, TAP
    /(\d+) failed(?:,| in )/g, // pytest
    /(\d+) failing/g, // mocha
  ];
  for (const re of patterns) {
    const found = [...text.matchAll(re)];
    if (found.length) return found.reduce((n, m) => n + Number(m[1]), 0);
  }
  const goFails = text.match(/^--- FAIL/gm);
  if (goFails) return goFails.length;
  const lines = text.split('\n').filter((l) => /\berror\b/i.test(l)).length;
  return lines || null;
}

/**
 * PORT для команды запуска — только если в ней нет {port}: иначе порт уже передан нужному процессу явно,
 * а общий PORT подхватили бы все процессы команды (например, API вместе с фронтом) и столкнулись на одном порту.
 */
export function portEnv(runCommand: string, port: number): Record<string, string> {
  return /\{port(:[\w-]+)?\}/.test(runCommand) ? {} : { PORT: String(port) };
}

/**
 * Подставить свободные порты: {port} — порт приложения, {port:имя} — дополнительные (API, воркер…),
 * у каждого прогона свои — параллельные прогоны не делят один порт и не ходят в чужой API.
 */
export async function expandPorts(url: string, command: string): Promise<{ port: number; url: string; command: string }> {
  const used = new Set<number>();
  const take = async () => {
    for (let i = 0; i < 20; i++) {
      const p = await freePort();
      if (!used.has(p)) return (used.add(p), p);
    }
    throw new Error('Не нашлось свободных портов');
  };
  const port = await take();
  const named = new Map<string, number>();
  for (const m of `${url} ${command}`.matchAll(/\{port:([a-z0-9_-]+)\}/gi)) {
    if (!named.has(m[1])) named.set(m[1], await take());
  }
  const fill = (t: string) =>
    t.replace(/\{port:([a-z0-9_-]+)\}/gi, (_, n: string) => String(named.get(n))).replaceAll('{port}', String(port));
  return { port, url: fill(url), command: fill(command) };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Ждём, пока адрес начнёт отвечать (любой HTTP-ответ), или пока процесс не умрёт. */
export async function waitForUrl(url: string, timeoutMs: number, abort: () => boolean): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (abort()) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(timer);
      return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** «shots» из JSON-ответа визуальной проверки. */
/** Визуальная проверка: причина, по которой проверить не удалось (поле "unverified"), иначе null. */
export function parseUnverified(text: string): string | null {
  try {
    const j = parseJsonReply<{ unverified?: unknown }>(text);
    return j && typeof j.unverified === 'string' && j.unverified.trim() ? j.unverified.trim().slice(0, 400) : null;
  } catch {
    return null;
  }
}

/** Вопросы уточнения из ответа планировщика (не больше 4). */
export function parseQuestions(text: string): ClarifyQuestion[] {
  try {
    const j = parseJsonReply<{ questions?: unknown }>(text);
    if (!j || !Array.isArray(j.questions)) return [];
    return j.questions
      .filter(
        (q): q is { q: string; options?: unknown; why?: unknown } =>
          Boolean(q) && typeof (q as { q?: unknown }).q === 'string' && (q as { q: string }).q.trim().length > 3,
      )
      .slice(0, 4)
      .map((q) => ({
        q: q.q.trim(),
        options: Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === 'string' && Boolean(o.trim())).slice(0, 4)
          : undefined,
        why: typeof q.why === 'string' && q.why.trim() ? q.why.trim() : undefined,
      }));
  } catch {
    return [];
  }
}

export function parseShots(text: string): { file: string; caption: string }[] {
  try {
    const j = parseJsonReply<Record<string, unknown>>(text);
    if (!j) return [];
    return Array.isArray(j.shots)
      ? j.shots
          .filter((x: { file?: unknown }) => typeof x?.file === 'string')
          .map((x: { file: string; caption?: unknown }) => ({ file: x.file, caption: String(x.caption ?? '') }))
      : [];
  } catch {
    return [];
  }
}

/** Число этапов большой задачи — разделы «## N.» в tasks.md. */
export function countPhases(tasks: string): number {
  return (tasks.match(/^##\s+\d+\./gm) ?? []).length;
}

export function firstLine(s: string): string {
  const line =
    s
      .trim()
      .split('\n')
      .find((l) => l.trim()) ?? '';
  return line.replace(/^[#>*\-\s]+/, '').slice(0, 160);
}

/** Достаём { blocking, notes } даже если модель обернула JSON в текст или ```json. */
export function parseReview(text: string): { blocking: ReviewItem[]; notes: ReviewItem[] } | null {
  const candidates: string[] = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const cand of candidates) {
    try {
      const j = JSON.parse(cand);
      if (j && Array.isArray(j.blocking) && Array.isArray(j.notes)) {
        const norm = (x: unknown): ReviewItem =>
          typeof x === 'string'
            ? { file: null, line: null, message: x }
            : {
                file: (x as ReviewItem).file ?? null,
                line: typeof (x as ReviewItem).line === 'number' ? (x as ReviewItem).line : null,
                message: String((x as ReviewItem).message ?? JSON.stringify(x)),
                ...(['new', 'unfixed', 'from_fix'].includes((x as ReviewItem).origin as string)
                  ? { origin: (x as ReviewItem).origin }
                  : {}),
              };
        return { blocking: j.blocking.map(norm), notes: j.notes.map(norm) };
      }
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** Растровое изображение — его можно показать агенту как картинку. */
export function isImageFile(p: string): boolean {
  return IMAGE_EXT.has(path.extname(p).toLowerCase());
}

/** Текст файла, если он небольшой и похож на текст (без нулевых байтов, валидный UTF-8); иначе null. */
export function readSmallText(p: string, max = 16 * 1024): string | null {
  try {
    if (fs.statSync(p).size > max) return null;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}
