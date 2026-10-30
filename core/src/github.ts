// Pull Request через GitHub CLI (gh): отправка ветки, создание PR, статус проверок CI, слияние.
import { run } from './proc.js';
import type { PrComment, PrStatus } from './types.js';

const T = 120_000;

async function gh(bin: string, cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const r = await run(bin, args, { cwd, env, timeoutMs: T });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `gh ${args[0]}: код ${r.code}`);
  return r.stdout.trim();
}

/** Можно ли создать PR: есть gh, он авторизован и у проекта есть удалённый репозиторий origin на GitHub. */
export async function prReadiness(ghBin: string | null, gitBin: string, repo: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!ghBin) return 'Нужен GitHub CLI: brew install gh, затем gh auth login';
  const remote = await run(gitBin, ['remote', 'get-url', 'origin'], { cwd: repo, env, timeoutMs: 10_000 });
  if (remote.code !== 0) return 'У проекта нет удалённого репозитория origin';
  if (!/github\.com[:/]/i.test(remote.stdout)) return 'origin не на GitHub — PR создаётся только для GitHub';
  const auth = await run(ghBin, ['auth', 'status'], { cwd: repo, env, timeoutMs: 20_000 });
  if (auth.code !== 0) return 'GitHub CLI не авторизован: выполните gh auth login';
  return null;
}

export async function pushBranch(gitBin: string, repo: string, branch: string, env: NodeJS.ProcessEnv) {
  const r = await run(gitBin, ['push', '-u', 'origin', `${branch}:${branch}`], {
    cwd: repo,
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: T,
  });
  if (r.code !== 0) throw new Error(`git push не прошёл: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
}

export async function createPr(
  ghBin: string,
  repo: string,
  env: NodeJS.ProcessEnv,
  o: { base: string; head: string; title: string; bodyFile: string },
): Promise<{ url: string; number: number }> {
  const out = await gh(ghBin, repo, env, [
    'pr',
    'create',
    '--base',
    o.base,
    '--head',
    o.head,
    '--title',
    o.title,
    '--body-file',
    o.bodyFile,
  ]);
  const url =
    out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^https:\/\/\S+\/pull\/\d+/.test(l)) ?? out.trim();
  return { url, number: Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0) };
}

interface Check {
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export async function prStatus(ghBin: string, repo: string, env: NodeJS.ProcessEnv, url: string): Promise<PrStatus> {
  const j = JSON.parse(
    await gh(ghBin, repo, env, [
      'pr',
      'view',
      url,
      '--json',
      'number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit,url',
    ]),
  ) as {
    number: number;
    state: string;
    isDraft: boolean;
    mergeable: string;
    mergeStateStatus: string;
    reviewDecision: string;
    statusCheckRollup: Check[] | null;
    mergeCommit: { oid: string } | null;
    url: string;
  };
  const checks = j.statusCheckRollup ?? [];
  // Проверки бывают двух видов: CheckRun (status/conclusion) и StatusContext (state).
  const verdict = (c: Check) => {
    const v = (c.conclusion || c.state || '').toUpperCase();
    if (c.status && c.status.toUpperCase() !== 'COMPLETED') return 'pending';
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) return 'ok';
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(v)) return 'pending';
    return 'failed';
  };
  const v = checks.map(verdict);
  const failedChecks = checks
    .filter((c, i) => v[i] === 'failed')
    .map((c) => ({ name: c.name || c.context || 'проверка', url: c.detailsUrl || c.targetUrl || null }));
  return {
    url: j.url,
    number: j.number,
    state: j.state as PrStatus['state'],
    draft: j.isDraft,
    mergeable: j.mergeable === 'MERGEABLE',
    conflicts: j.mergeable === 'CONFLICTING',
    blocked: j.mergeStateStatus === 'BLOCKED',
    behind: j.mergeStateStatus === 'BEHIND' || j.mergeable === 'CONFLICTING',
    review: j.reviewDecision || null,
    checks: {
      total: v.length,
      passed: v.filter((x) => x === 'ok').length,
      failed: v.filter((x) => x === 'failed').length,
      pending: v.filter((x) => x === 'pending').length,
    },
    failedChecks,
    mergeCommit: j.mergeCommit?.oid ?? null,
  };
}

export async function mergePr(ghBin: string, repo: string, env: NodeJS.ProcessEnv, url: string) {
  await gh(ghBin, repo, env, ['pr', 'merge', url, '--merge']);
}

/** owner, repo и номер из ссылки на PR. */
export function parsePrUrl(url: string): { owner: string; name: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}

const PR_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
title
reviews(last:50){nodes{id author{login} body state submittedAt url}}
comments(last:100){nodes{id author{login} body createdAt url}}
reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine comments(first:50){nodes{author{login} body createdAt url}}}}
}}}`;

interface Gql {
  data?: {
    repository?: {
      pullRequest?: {
        title: string;
        reviews: {
          nodes: { id: string; author: { login: string } | null; body: string; state: string; submittedAt: string; url: string }[];
        };
        comments: { nodes: { id: string; author: { login: string } | null; body: string; createdAt: string; url: string }[] };
        reviewThreads: {
          nodes: {
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path: string;
            line: number | null;
            originalLine: number | null;
            comments: { nodes: { author: { login: string } | null; body: string; createdAt: string; url: string }[] };
          }[];
        };
      };
    };
  };
  errors?: { message: string }[];
}

/** Обсуждения в коде, итоги ревью и общие комментарии PR — одним запросом GraphQL. */
export async function prComments(
  ghBin: string,
  repo: string,
  env: NodeJS.ProcessEnv,
  url: string,
): Promise<{ title: string; comments: PrComment[] }> {
  const p = parsePrUrl(url);
  if (!p) throw new Error(`Не похоже на ссылку на PR: ${url}`);
  const j = JSON.parse(
    await gh(ghBin, repo, env, [
      'api',
      'graphql',
      '-f',
      `query=${PR_QUERY}`,
      '-F',
      `owner=${p.owner}`,
      '-F',
      `name=${p.name}`,
      '-F',
      `n=${p.number}`,
    ]),
  ) as Gql;
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join('; '));
  const pr = j.data?.repository?.pullRequest;
  if (!pr) throw new Error('PR не найден');
  const who = (a: { login: string } | null) => a?.login ?? 'ghost';
  const out: PrComment[] = [];
  for (const t of pr.reviewThreads.nodes) {
    const [first, ...rest] = t.comments.nodes;
    if (!first) continue;
    out.push({
      id: t.id,
      kind: 'thread',
      author: who(first.author),
      body: first.body,
      at: first.createdAt,
      url: first.url,
      path: t.path,
      line: t.line ?? t.originalLine ?? undefined,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      replies: rest.map((c) => ({ author: who(c.author), body: c.body, at: c.createdAt })),
    });
  }
  // Итог ревью без текста («Approved» без слов) отработать нечего.
  for (const r of pr.reviews.nodes)
    if (r.body.trim())
      out.push({ id: r.id, kind: 'review', author: who(r.author), body: r.body, at: r.submittedAt, url: r.url, state: r.state });
  for (const c of pr.comments.nodes)
    out.push({ id: c.id, kind: 'comment', author: who(c.author), body: c.body, at: c.createdAt, url: c.url });
  return { title: pr.title, comments: out.sort((a, b) => a.at.localeCompare(b.at)) };
}

/** Хвост лога упавшего job GitHub Actions (по ссылке из проверки). null — не Actions или лог недоступен. */
export async function failedJobLog(ghBin: string, repo: string, env: NodeJS.ProcessEnv, checkUrl: string): Promise<string | null> {
  const m = checkUrl.match(/\/actions\/runs\/(\d+)\/job(?:s)?\/(\d+)/);
  if (!m) return null;
  const r = await run(ghBin, ['run', 'view', m[1], '--job', m[2], '--log-failed'], { cwd: repo, env, timeoutMs: T });
  if (r.code !== 0) return null;
  // Строки вида «job\tstep\t2024-…Z текст» — оставляем текст.
  const lines = r.stdout
    .split('\n')
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+Z\s?/, ''))
    .filter((l) => l.trim());
  return lines.slice(-120).join('\n');
}
