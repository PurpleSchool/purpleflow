// Ветки и Pull Request: слияние результата, PR на GitHub, статус CI и круг доработки по замечаниям.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { c } from '../agents/common.js';
import { which } from '../env.js';
import { Git } from '../git.js';
import { createPr, failedJobLog, mergePr, prComments, prReadiness, prStatus, pushBranch } from '../github.js';
import { isRunBranch } from '../ids.js';
import type { Kernel } from '../kernel.js';

import type { PrDetails, PrFollowupItem, PrStatus, RunFile } from '../types.js';
import { getChangeDocs } from './runs.js';
import { copyEnvFiles } from './workspace.js';
export function ghBin(h: Kernel): string | null {
  return which('gh', h.opts.env);
}

/** null — PR создать можно; иначе причина, почему нет (нет gh, origin не на GitHub…). */
export async function prReady(h: Kernel, id: string): Promise<string | null> {
  const r = h.mustLoad(id);
  const tools = await h.tools(['git']);
  return prReadiness(ghBin(h), tools.git, r.projectPath, h.opts.env);
}

export async function openPr(h: Kernel, id: string, base: string) {
  const r = h.mustLoad(id);
  if (r.status !== 'finished') throw new Error('PR можно открыть только для завершённого прогона');
  if (r.pr) throw new Error(`PR уже открыт: ${r.pr.url}`);
  if (!base.trim()) throw new Error('Выберите ветку, в которую открыть PR');
  const tools = await h.tools(['git']);
  const gh = ghBin(h);
  const why = await prReadiness(gh, tools.git, r.projectPath, h.opts.env);
  if (why || !gh) throw new Error(why ?? 'Нет gh');
  h.log(r, c.sky(`$ git push -u origin ${r.branch}`) + '\n');
  await pushBranch(tools.git, r.projectPath, r.branch, h.opts.env);
  const bodyFile = path.join(os.tmpdir(), `purpleflow-pr-${r.id}.md`);
  fs.writeFileSync(bodyFile, await prBody(h, r));
  try {
    const pr = await createPr(gh, r.projectPath, h.opts.env, { base, head: r.branch, title: r.title, bodyFile });
    r.pr = { ...pr, base, createdAt: new Date().toISOString() };
    h.save(r);
    h.log(r, c.mint(`✓ PR #${pr.number}: ${pr.url}`) + '\n');
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

/** Описание PR: задача, итог исполнителя, план, проверки, ревью и визуальная проверка — из прогона. */
export async function prBody(h: Kernel, r: RunFile): Promise<string> {
  const docs = await getChangeDocs(h, r.id).catch(() => null);
  const impl = [...r.attempts].reverse().find((a) => a.stage === 'implement' && a.output)?.output;
  const lastTest = r.tests.at(-1);
  const review = r.reviews.at(-1);
  const visual = r.visuals?.at(-1);
  const parts: string[] = [`## Задача\n\n${r.task}`];
  if (impl) parts.push(`## Что сделано\n\n${impl.slice(0, 4000)}`);
  if (docs?.proposal) parts.push(`## План (OpenSpec \`${r.changeId}\`)\n\n${docs.proposal.replace(/^#\s+.*\n+/, '').slice(0, 4000)}`);
  if (lastTest?.checks?.length) {
    parts.push(
      `## Проверки\n\n${lastTest.checks.map((x) => `- ${x.kind === 'lint' ? 'Линтер' : 'Тесты'}: ${x.unstable ? '⚠️ нестабильные, не из‑за задачи' : x.passed ? '✅' : x.preexisting ? '⚠️ красные и до задачи, новых ошибок нет' : '❌'} \`${x.command}\``).join('\n')}`,
    );
  }
  if (review) {
    const notes = review.notes.map((n) => `- ${n.file ? `\`${n.file}${n.line ? ':' + n.line : ''}\` — ` : ''}${n.message}`).join('\n');
    parts.push(
      `## Ревью (${r.agents.reviewer})\n\n${review.blocking.length ? `Блокирующих: ${review.blocking.length}` : 'Блокирующих замечаний нет.'}${notes ? `\n\nЗаметки:\n${notes}` : ''}`,
    );
  }
  if (visual) {
    parts.push(
      `## Визуальная проверка\n\n${visual.unverified ? `⚠️ Проверить не удалось: ${visual.unverified}` : visual.blocking.length ? `Проблем: ${visual.blocking.length}` : '✅ В браузере всё выглядит верно'}${visual.shots.length ? `\n\nСкриншоты (${visual.shots.length}) — в PurpleFlow:\n${visual.shots.map((s) => `- ${s.caption}`).join('\n')}` : ''}`,
    );
  }
  parts.push(`---\nСделано в PurpleFlow · режим «${r.mode}» · прогон \`${r.id.slice(0, 8)}\``);
  return parts.join('\n\n');
}

export async function getPrStatus(h: Kernel, id: string): Promise<PrStatus | null> {
  const r = h.mustLoad(id);
  const gh = ghBin(h);
  if (!r.pr || !gh) return null;
  const st = await prStatus(gh, r.projectPath, h.opts.env, r.pr.url);
  // Влили на GitHub (из приложения или руками) — отмечаем у прогона.
  if (st.state === 'MERGED' && !r.merged) {
    r.merged = { into: r.pr.base, commit: st.mergeCommit ?? '', at: new Date().toISOString() };
    h.save(r);
  }
  return st;
}

/** PR с замечаниями — по запросу со вкладки «Pull Request» (без фонового опроса). */
export async function getPrDetails(h: Kernel, id: string): Promise<PrDetails | null> {
  const r = h.mustLoad(id);
  const gh = ghBin(h);
  if (!r.pr || !gh) return null;
  const [status, c] = await Promise.all([getPrStatus(h, id), prComments(gh, r.projectPath, h.opts.env, r.pr.url)]);
  if (!status) return null;
  const checks = (status.failedChecks ?? []).map((x, i) => ({
    id: `check:${x.name}:${i}`,
    kind: 'check' as const,
    author: 'CI',
    body: x.name,
    at: new Date().toISOString(),
    url: x.url ?? undefined,
  }));
  return { title: c.title, status, comments: [...checks, ...c.comments], fetchedAt: new Date().toISOString() };
}

/**
 * Доработка по замечаниям PR — новый круг в том же прогоне: реализация → проверки → ревью → приёмка → коммит и push в ветку PR.
 * Запускается только человеком.
 */
export async function prFollowup(h: Kernel, id: string, items: PrFollowupItem[], note?: string) {
  const r = h.mustLoad(id);
  if (!r.pr) throw new Error('У прогона нет PR');
  if (r.status !== 'finished') throw new Error('Доработку можно начать, когда прогон завершён');
  if (r.merged) throw new Error('PR уже влит — для новых правок создайте новую задачу');
  if (!items.length && !note?.trim()) throw new Error('Выберите замечания или опишите, что доработать');
  const { git, pulled } = await reopenWorkspace(h, r);

  // Логи упавших проверок CI — исполнителю, чтобы не гадать, что сломалось.
  const gh = ghBin(h);
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === 'check') {
      const log = gh && it.url ? await failedJobLog(gh, r.projectPath, h.opts.env, it.url).catch(() => null) : null;
      lines.push(`- Упала проверка CI «${it.body}»${it.url ? ` (${it.url})` : ''}${log ? `. Хвост лога:\n\`\`\`\n${log}\n\`\`\`` : ''}`);
    } else {
      const where = it.path ? `${it.path}${it.line ? `:${it.line}` : ''}` : it.kind === 'review' ? 'итог ревью' : 'комментарий к PR';
      lines.push(`- ${where} — @${it.author}: ${it.body.trim()}`);
    }
  }
  const round = (r.prRound ?? 1) + 1;
  r.prRound = round;
  r.roundBase = await git.head(r.worktreePath);
  r.prRounds = [...(r.prRounds ?? []), { round, at: new Date().toISOString(), items, note: note?.trim() || undefined }];
  r.feedback = {
    source: 'human',
    text: [
      `Задача уже сделана и отправлена в Pull Request #${r.pr.number}${r.archivedPath ? ' (изменение OpenSpec в архиве — tasks.md не трогай)' : ''}. Ревьюеры оставили замечания — отработай только их, остальное не переделывай.`,
      'Если замечание — вопрос или с ним нельзя согласиться, не меняй код, а объясни это в отчёте.',
      lines.length ? `Замечания:\n${lines.join('\n')}` : '',
      note?.trim() ? `Комментарий человека:\n${note.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
  r.status = 'running';
  r.next = 'implement';
  r.finishedAt = undefined;
  r.message = undefined;
  r.implAttemptsLimit = r.implAttemptsUsed + 3;
  h.log(
    r,
    '\n' +
      c.violet(c.bold(`━━ Доработка по PR #${r.pr.number} · круг ${round}`)) +
      '\n' +
      c.dim(`замечаний: ${items.length}${pulled === 'updated' ? ' · подтянуты новые коммиты из ветки PR' : ''}`) +
      '\n',
  );
  h.save(r);
  h.emit({ type: 'run.updated', run: r });
  void h.engine.drive(r);
}

/** Рабочая копия завершённого прогона для нового круга: worktree могли удалить, проект в режиме «ветка» — переключить. */
export async function reopenWorkspace(h: Kernel, r: RunFile): Promise<{ git: Git; pulled: 'updated' | 'same' | 'diverged' | 'no-remote' }> {
  const tools = await h.tools(['git']);
  const git = new Git(tools.git, h.opts.env);

  // Рабочая копия: worktree могли удалить при очистке, в режиме «ветка» проект мог уйти на другую ветку.
  if (r.workspace === 'branch') {
    const cur = await git.currentBranch(r.projectPath);
    if (cur !== r.branch) {
      const dirty = await git.dirtyFiles(r.projectPath);
      if (dirty.length)
        throw new Error(
          `В проекте есть незакоммиченные изменения (${dirty.length}) — закоммитьте или уберите их, чтобы переключиться на ${r.branch}`,
        );
      await git.checkout(r.projectPath, r.branch);
    }
  } else if (r.worktreeRemoved || !fs.existsSync(r.worktreePath)) {
    await git.addWorktreeAt(r.projectPath, r.worktreePath, r.branch);
    r.worktreeRemoved = undefined;
    copyEnvFiles(h, r);
  }
  const pulled = await git.pullFastForward(r.worktreePath, r.branch);
  if (pulled === 'diverged')
    throw new Error(`Ветка ${r.branch} на GitHub разошлась с локальной — подтяните изменения вручную (git pull) и повторите`);
  return { git, pulled };
}

/**
 * «Обновить ветку»: влить свежую базовую ветку PR в ветку прогона.
 * Без конфликтов — проверки и push; с конфликтами — исполнитель разрешает их, затем проверки и приёмка.
 */
export async function updateBranch(h: Kernel, id: string) {
  const r = h.mustLoad(id);
  if (!r.pr) throw new Error('У прогона нет PR');
  if (r.status !== 'finished') throw new Error('Обновить ветку можно, когда прогон завершён');
  if (r.merged) throw new Error('PR уже влит');
  const { git } = await reopenWorkspace(h, r);
  const base = r.pr.base;
  await git.fetchRef(r.worktreePath, base);
  const round = (r.prRound ?? 1) + 1;
  r.roundBase = await git.head(r.worktreePath);
  const m = await git.mergeRef(r.worktreePath, 'FETCH_HEAD', `Merge ${base} в ${r.branch}`);
  if (!m.changed) {
    h.log(r, c.dim(`ветка ${r.branch} уже содержит всё из ${base} — обновлять нечего`) + '\n');
    throw new Error(`Ветка уже содержит всё из ${base}`);
  }
  r.prRound = round;
  r.prRounds = [
    ...(r.prRounds ?? []),
    {
      round,
      at: new Date().toISOString(),
      items: [],
      kind: 'update',
      conflicts: m.conflicts.length ? m.conflicts : undefined,
      note: `Обновление из ${base}`,
    },
  ];
  r.status = 'running';
  r.finishedAt = undefined;
  r.message = undefined;
  h.log(r, '\n' + c.violet(c.bold(`━━ Обновление ветки из ${base} · круг ${round}`)) + '\n');
  if (m.conflicts.length) {
    r.roundFiles = m.conflicts;
    r.mergeOnly = undefined;
    r.next = 'implement';
    r.implAttemptsLimit = r.implAttemptsUsed + 3;
    r.feedback = {
      source: 'validator',
      text: [
        `Идёт слияние свежей ветки ${base} в ветку задачи ${r.branch} — в файлах конфликты. Задача уже сделана; сейчас нужно только разрешить конфликты.`,
        `Файлы с конфликтами:\n${m.conflicts.map((f) => `- ${f}`).join('\n')}`,
        `Разреши каждый конфликт так, чтобы сохранились и изменения из ${base}, и изменения задачи. Убери все маркеры <<<<<<< ======= >>>>>>>. Если ${base} что-то переименовал или поменял API — подстрой под это код задачи.`,
        'Не выполняй git commit, git merge --abort и git reset — слияние завершит оркестратор после проверок.',
      ].join('\n\n'),
    };
    h.log(r, c.amber(`! конфликты: ${m.conflicts.join(', ')} — их разрешит исполнитель`) + '\n');
  } else {
    r.roundFiles = undefined;
    r.mergeOnly = true;
    r.next = 'tests';
    h.log(r, c.mint(`✓ ${base} влита без конфликтов — проверки и отправка в PR`) + '\n');
  }
  h.save(r);
  h.emit({ type: 'run.updated', run: r });
  void h.engine.drive(r);
}

export async function mergePrOf(h: Kernel, id: string) {
  const r = h.mustLoad(id);
  const gh = ghBin(h);
  if (!r.pr || !gh) throw new Error('У прогона нет PR');
  await mergePr(gh, r.projectPath, h.opts.env, r.pr.url);
  h.log(r, c.mint(`✓ PR #${r.pr.number} влит в ${r.pr.base}`) + '\n');
  await getPrStatus(h, id);
}

/** Ветки репозитория пользователя для слияния результата. */
export async function listBranches(
  h: Kernel,
  id: string,
): Promise<{ branches: string[]; current: string | null; suggested: string | null }> {
  const r = h.mustLoad(id);
  const tools = await h.tools(['git']);
  const b = await new Git(tools.git, h.opts.env).branches(r.projectPath);
  const branches = b.branches.filter((x) => x !== r.branch && !isRunBranch(x));
  // Куда вливать по умолчанию: ветка, от которой начинали задачу, иначе main/master, иначе текущая.
  const from = r.baseBranch?.replace(/^origin\//, '');
  const suggested = [from, 'main', 'master', b.current].find((x): x is string => Boolean(x && branches.includes(x))) ?? branches[0] ?? null;
  return { branches, current: b.current, suggested };
}

/** Влить ветку прогона в выбранную ветку репозитория пользователя (решение человека). */
export async function merge(h: Kernel, id: string, target: string) {
  const r = h.mustLoad(id);
  if (r.status !== 'finished') throw new Error('Влить можно только завершённый прогон');
  if (!target.trim()) throw new Error('Выберите ветку');
  const tools = await h.tools(['git']);
  const git = new Git(tools.git, h.opts.env);
  const sha = await git.merge(r.projectPath, r.branch, target, `Merge ${r.branch}: ${r.title}`, h.store.worktreesDir());
  r.merged = { into: target, commit: sha, at: new Date().toISOString() };
  h.save(r);
  h.log(r, c.mint(`✓ ${r.branch} влита в ${target} (${sha.slice(0, 8)})`) + '\n');
}
