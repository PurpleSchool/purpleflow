// Pull Request через GitHub CLI (gh): отправка ветки, создание PR, статус проверок CI, слияние.
import { run } from './proc.js';
import type { PrStatus } from './types.js';

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
  const r = await run(gitBin, ['push', '-u', 'origin', `${branch}:${branch}`], { cwd: repo, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: T });
  if (r.code !== 0) throw new Error(`git push не прошёл: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
}

export async function createPr(ghBin: string, repo: string, env: NodeJS.ProcessEnv, o: { base: string; head: string; title: string; bodyFile: string }): Promise<{ url: string; number: number }> {
  const out = await gh(ghBin, repo, env, ['pr', 'create', '--base', o.base, '--head', o.head, '--title', o.title, '--body-file', o.bodyFile]);
  const url = out.split('\n').map((l) => l.trim()).find((l) => /^https:\/\/\S+\/pull\/\d+/.test(l)) ?? out.trim();
  return { url, number: Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0) };
}

interface Check { status?: string; conclusion?: string; state?: string }

export async function prStatus(ghBin: string, repo: string, env: NodeJS.ProcessEnv, url: string): Promise<PrStatus> {
  const j = JSON.parse(await gh(ghBin, repo, env, ['pr', 'view', url, '--json', 'number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit,url'])) as {
    number: number; state: string; isDraft: boolean; mergeable: string; mergeStateStatus: string; reviewDecision: string;
    statusCheckRollup: Check[] | null; mergeCommit: { oid: string } | null; url: string;
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
  return {
    url: j.url,
    number: j.number,
    state: j.state as PrStatus['state'],
    draft: j.isDraft,
    mergeable: j.mergeable === 'MERGEABLE',
    conflicts: j.mergeable === 'CONFLICTING',
    blocked: j.mergeStateStatus === 'BLOCKED',
    review: j.reviewDecision || null,
    checks: { total: v.length, passed: v.filter((x) => x === 'ok').length, failed: v.filter((x) => x === 'failed').length, pending: v.filter((x) => x === 'pending').length },
    mergeCommit: j.mergeCommit?.oid ?? null,
  };
}

export async function mergePr(ghBin: string, repo: string, env: NodeJS.ProcessEnv, url: string) {
  await gh(ghBin, repo, env, ['pr', 'merge', url, '--merge']);
}
