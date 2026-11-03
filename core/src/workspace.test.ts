// Сбой при подготовке рабочей копии: прогона нет, а проект остаётся таким, каким был.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.js';
import type { CoreEvent, CoreSettings } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const unix = { skip: process.platform === 'win32' };

function setup(t: { after: (fn: () => void) => void }, openspec: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ws-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo }).toString().trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'openspec'), `#!/bin/sh\n[ "$1" = "--version" ] && echo 1.0.0 && exit 0\n${openspec}\n`, { mode: 0o755 });
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude'), openspec: path.join(bin, 'openspec') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 5,
    testTimeoutMin: 2,
    maxParallel: 2,
  } as unknown as CoreSettings;
  const core = new Orchestrator({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env: process.env,
    getSettings: () => settings,
    runners: { claude: (async () => ({ ok: true, text: '{}', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) as never },
  });
  const events: CoreEvent[] = [];
  core.on((e) => events.push(e));
  return { core, repo, g, events };
}

for (const workspace of ['worktree', 'branch'] as const) {
  test(`сбой openspec init (${workspace}): откат ветки и копии, прогон исчезает`, unix, async (t) => {
    const { core, repo, g, events } = setup(t, 'echo не вышло >&2; echo мусор > init.log; exit 1');
    await assert.rejects(
      core.dispatch({
        type: 'run.start',
        input: { projectPath: repo, task: 'Задача', testCommand: 'true', mode: 'task', workspace } as never,
      }),
      /openspec init не удался/,
    );
    assert.equal(g('branch', '--show-current'), 'main');
    assert.equal(g('branch', '--list', 'purpleflow/*'), '');
    assert.equal(g('worktree', 'list').split('\n').length, 1);
    assert.equal(g('status', '--porcelain'), '', 'следы init убраны');
    assert.deepEqual(await core.listRuns(), []);
    assert.ok(events.some((e) => e.type === 'run.deleted'));
  });
}

test('грязная копия в режиме «ветка»: ничего не создано', unix, async (t) => {
  const { core, repo, g } = setup(t, 'exit 1');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'правка человека\n');
  await assert.rejects(
    core.dispatch({
      type: 'run.start',
      input: { projectPath: repo, task: 'Задача', testCommand: 'true', mode: 'task', workspace: 'branch' } as never,
    }),
    /незакоммиченн/,
  );
  assert.equal(g('branch', '--show-current'), 'main');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'правка человека\n', 'чужая правка цела');
  assert.deepEqual(await core.listRuns(), []);
});
