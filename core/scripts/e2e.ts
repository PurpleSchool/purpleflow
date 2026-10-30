// Headless-прогон флоу на настоящих агентах (для проверки без GUI).
// npx tsx scripts/e2e.ts --repo ~/purpleflow-sample --task "…" [--reject-plan "комментарий"] [--stop-after-ms 20000]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, loadLoginShellEnv, liveCount, type CoreSettings } from '../src/index.js';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(arg('repo') ?? path.join(os.homedir(), 'purpleflow-sample'));
const task = arg('task') ?? 'Добавь функцию slugify(s: string): string в src/strings.ts: переводит строку в kebab-case латиницей (кириллицу транслитерирует), убирает всё кроме букв, цифр и дефисов. Добавь тест.';
let rejectPlan = arg('reject-plan');
const stopAfter = arg('stop-after-ms');
// Аварийный выход: процесс ядра умирает без уборки, как при падении приложения.
const crashOn = arg('crash-on-stage');
// Продолжить прогон после «перезапуска приложения».
const resumeRun = arg('resume-run');

const settings: CoreSettings = {
  toolPaths: { openspec: process.env.PURPLEFLOW_OPENSPEC ?? '' },
  proxy: { baseUrl: process.env.PURPLEFLOW_BASE_URL ?? '', apiKey: process.env.PURPLEFLOW_API_KEY ?? '' },
  models: {
    planner: process.env.PURPLEFLOW_PLANNER ?? 'sonnet',
    executor: process.env.PURPLEFLOW_EXECUTOR ?? 'sonnet',
    reviewer: process.env.PURPLEFLOW_REVIEWER ?? '',
  },
  // --agents planner=claude,executor=codex,reviewer=claude
  agents: Object.fromEntries((process.argv[process.argv.indexOf('--agents') + 1] ?? '').split(',').filter((x) => x.includes('=') && process.argv.includes('--agents')).map((x) => x.split('='))),
  agentTimeoutMin: 20,
  testTimeoutMin: 5,
};

const core = new Orchestrator({
  dataDir: arg('data') ?? path.join(os.tmpdir(), 'purpleflow-e2e'),
  promptsDir: path.join(here, '..', 'prompts'),
  env: loadLoginShellEnv(),
  getSettings: () => settings,
});

let frames = 0;
const started = Date.now();
const t = () => `[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s]`;

const done = new Promise<void>((resolve) => {
  core.on((e) => {
    if (e.type === 'agent.output') {
      if (argv.includes('--verbose')) process.stdout.write(e.text.replace(/\r\n/g, '\n'));
      return;
    }
    if (e.type === 'run.updated') return;
    if (e.type === 'visual.frame') {
      frames++;
      if (e.frame && argv.includes('--save-frame')) fs.writeFileSync(path.join(arg('data') ?? os.tmpdir(), 'last-frame.jpg'), Buffer.from(e.frame.data, 'base64'));
      return;
    }
    console.log(t(), e.type, JSON.stringify({ ...e, runId: undefined }).slice(0, 400));
    if (crashOn && e.type === 'stage.started' && e.stage === crashOn) {
      setTimeout(() => {
        console.log(t(), 'CRASH', e.runId);
        process.exit(9);
      }, 6000);
    }
    if (e.type === 'gate.waiting') {
      setTimeout(() => {
        if (e.gate === 'gate1' && rejectPlan) {
          const comment = rejectPlan;
          rejectPlan = undefined;
          void core.dispatch({ type: 'gate.reject', runId: e.runId, comment });
        } else if (e.gate === 'limit') {
          void core.dispatch({ type: 'gate.cancel', runId: e.runId });
        } else {
          void core.dispatch({ type: 'gate.approve', runId: e.runId });
        }
      }, 200);
    }
    if (e.type === 'run.finished') resolve();
  });
});

let runId: string;
if (resumeRun) {
  await core.recover();
  const before = core.getRun(resumeRun)!;
  console.log(t(), 'recovered', before.status, before.next, '|', before.message ?? '');
  runId = resumeRun;
  if (before.status === 'waiting') await core.dispatch({ type: 'gate.approve', runId });
  else await core.dispatch({ type: 'run.resume', runId });
} else {
  const image = arg('image');
  const attachments = image ? [{ name: path.basename(image), data: new Uint8Array(fs.readFileSync(image)) }] : undefined;
  ({ runId } = await core.dispatch({ type: 'run.start', input: { projectPath: repo, task, testCommand: arg('test') ?? 'npm test', lintCommand: arg('lint'), attachments, mode: (arg('mode') as never) ?? 'task', visual: Boolean(arg('run')), runCommand: arg('run'), appUrl: arg('url'), workspace: (arg('workspace') as never) ?? 'worktree', envFiles: arg('env')?.split(',') } }));
}
console.log(t(), 'run', runId);
if (stopAfter) {
  setTimeout(() => {
    console.log(t(), 'STOP');
    void core.dispatch({ type: 'run.stop', runId });
  }, Number(stopAfter));
}
await done;
await new Promise((r) => setTimeout(r, 500));
const run = core.getRun(runId)!;
console.log(t(), 'status', run.status, '| attempts', run.attempts.map((a) => `${a.stage}#${a.attempt}:${a.status}`).join(' '));
console.log(t(), 'title', JSON.stringify(run.title), 'fromPlan', run.titleFromPlan, 'attachments', run.attachments);
console.log(t(), 'mode', run.mode, 'phases', run.phases, 'repro', run.repro && { passed: run.repro.passed }, 'visuals', JSON.stringify(run.visuals?.map((v) => ({ blocking: v.blocking.length, notes: v.notes.length, shots: v.shots.map((x) => x.caption) }))));
console.log(t(), 'tokens', JSON.stringify(run.totals), '| live processes', liveCount(), '| frames', frames);
console.log(t(), 'run.json', run.archivedPath ?? path.join(run.worktreePath, 'openspec/changes', run.changeId, 'run.json'));
