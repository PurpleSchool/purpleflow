// Проверка настоящих CLI: фейки в тестах повторяют их формат вывода, и только здесь видно, что формат ещё тот.
// npm run check:agents -w core             — только версии, без трат
// npm run check:agents -w core -- --live   — ещё и короткий запрос к claude и codex (расходует токены)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from '../src/agents/claude.js';
import { runCodex } from '../src/agents/codex.js';
import { detectTool, loadLoginShellEnv } from '../src/env.js';

const live = process.argv.includes('--live');
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');
const wanted = (name: string) => !only || only.includes(name);
const env = await loadLoginShellEnv();
let failed = false;

const report = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed = true;
};

for (const name of ['claude', 'codex'] as const) {
  if (!wanted(name)) continue;
  const t = await detectTool(name, env);
  report(`${name} --version`, Boolean(t.version), t.version ?? t.error ?? 'нет версии');
}

if (wanted('gh')) {
  // Формат JSON у gh проверяется запросом к публичному репозиторию: токены агентов не тратятся.
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--repo', 'cli/cli', '--limit', '1', '--json', 'number,url,isDraft,mergeable,statusCheckRollup'],
      {
        env,
        encoding: 'utf8',
      },
    );
    const [pr] = JSON.parse(out) as { number?: number; url?: string }[];
    report('gh pr list --json', Boolean(pr?.number && pr.url), 'поля на месте');
  } catch (e) {
    report('gh pr list --json', false, (e as Error).message.split('\n')[0]);
  }
}

if (live) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agents-'));
  const prompt = 'Ответь одним словом: готово. Не используй инструменты.';
  const common = { cwd, env, prompt, timeoutMs: 180_000, group: 'check-agents', onOutput: () => {} };
  if (wanted('claude')) {
    const bin = (await detectTool('claude', env)).path;
    const r = bin ? await runClaude({ ...common, bin, model: 'haiku', claudeAuth: env.ANTHROPIC_API_KEY ? 'env' : 'login' }) : null;
    report('claude: запрос и разбор stream-json', Boolean(r?.ok && r.text.trim() && r.usage.output > 0), r?.error ?? `«${r?.text.trim()}»`);
  }
  if (wanted('codex')) {
    const bin = (await detectTool('codex', env)).path;
    const r = bin ? await runCodex({ ...common, bin, sandbox: 'read-only' }) : null;
    report('codex: запрос и разбор JSONL', Boolean(r?.ok && r.text.trim()), r?.error ?? `«${r?.text.trim()}»`);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
