// Стадия «Реализация»: исполнитель выполняет tasks.md, продолжая свою сессию между попытками.
import crypto from 'node:crypto';
import { c, type AgentResult } from '../agents/common.js';
import { Git } from '../git.js';
import type { Kernel } from '../kernel.js';

import { firstLine } from '../parse.js';
import { ARTIFACT_RE } from '../reviewdiff.js';
import { runRole } from '../services/agents.js';
import { attachmentsBlock } from '../services/attachments.js';
import { checkRelatedUntouched, relatedState } from '../services/projects.js';
import { feedbackBlock, modeRules, phaseBlock, taskText, tpl } from '../services/prompting.js';

import { repoSlots, slotPath } from '../services/repos.js';
import type { AgentKind, RunFile } from '../types.js';
import { captureBaseChecks, settleBaseChecks } from './checks.js';
import { startFilesBlock } from './plan.js';
export async function stageImplement(k: Kernel, run: RunFile) {
  const firstAttempt = !run.attempts.some((x) => x.stage === 'implement');
  // Быстрая правка идёт без плана. Старые прогоны могли пропустить подготовку и прийти сюда повторно.
  if (firstAttempt || (run.mode === 'quick' && !run.prepared && run.setupCommand)) await settleBaseChecks(k, run);
  // Эталон снимаем только до первой реализации, пока агент ещё ничего не менял.
  if (firstAttempt) await captureBaseChecks(k, run);
  run.implAttemptsUsed++;
  const attempt = k.begin(run, 'implement', run.models.executor);
  const prompt = k.prompts.render(tpl(k, 'implement', run), {
    changeId: run.changeId,
    task: taskText(k, run),
    attachments: attachmentsBlock(k, run) + (await startFilesBlock(k, run)),
    testCommand: run.testCommand || 'не задана',
    attempt: run.implAttemptsUsed,
    limit: run.implAttemptsLimit,
    feedback: phaseBlock(k, run) + feedbackBlock(k, run.feedback),
  });
  let res: AgentResult;
  const systemPrompt = k.prompts.raw('executor.system.md') + modeRules(k, 'executor', run);
  const agent = run.agents.executor;
  const onClaude = agent === 'claude';
  // claude и opencode умеют продолжить сессию; codex exec — нет, у него каждая попытка с нуля.
  const resumable = onClaude || agent === 'opencode';
  // opencode сам выдаёт ID сессии — запоминаем, как только он его сообщил.
  const onSession = agent === 'opencode' ? (id: string) => setSession(run, agent, id) : undefined;
  const related = await relatedState(k, run.projectPath);
  try {
    // Следующая попытка продолжает сессию прошлой: только замечания, без повторного изучения проекта.
    if (resumable && run.executorSession && (run.executorSessionAgent ?? 'claude') === agent) {
      k.log(run, c.dim('продолжаю сессию исполнителя — в контексте прошлая попытка') + '\n');
      const short = k.prompts.render('implement-continue.md', {
        changeId: run.changeId,
        testCommand: run.testCommand || 'не задана',
        attempt: run.implAttemptsUsed,
        limit: run.implAttemptsLimit,
        feedback: phaseBlock(k, run) + feedbackBlock(k, run.feedback),
      });
      res = await runRole(k, run, 'executor', { prompt: short, systemPrompt, openspec: true, resume: run.executorSession, onSession });
      if (!res.ok && !res.stopped && /no conversation|session|не найден/i.test(res.error ?? '')) {
        // Сессия пропала (чистка ~/.claude или данных opencode, другой компьютер) — начинаем заново с полной постановкой.
        k.log(run, c.dim('сессия не найдена — начинаю заново') + '\n');
        res = await freshAttempt(k, run, prompt, systemPrompt, onSession);
      }
    } else {
      res = await freshAttempt(k, run, prompt, systemPrompt, onSession);
    }
    k.afterAgent(run, attempt, res);
    await checkRelatedUntouched(k, run, related);
  } catch (e) {
    // Сбой агента (ключ, токены, таймаут) не тратит попытку реализации.
    run.implAttemptsUsed--;
    throw e;
  }
  if (run.mode === 'quick' && !run.titleFromPlan) {
    // Плана нет — короткое название пишет исполнитель последней строкой «НАЗВАНИЕ: …».
    const m = res.text.match(/НАЗВАНИЕ:\s*(.+)\s*$/m);
    if (m) {
      run.title = m[1].replace(/[`*]/g, '').trim().slice(0, 72);
      run.titleFromPlan = true;
    }
  }
  const report = res.text.replace(/^НАЗВАНИЕ:.*$/m, '').trim();
  if (report) attempt.output = report;
  k.end(run, attempt, 'done', firstLine(report) || 'Реализация выполнена');
  await dropArtifacts(k, run);
  run.next = 'tests';
  k.save(run);
}

function setSession(run: RunFile, agent: AgentKind, id: string | undefined) {
  run.executorSession = id;
  run.executorSessionAgent = id ? agent : undefined;
}

/** Попытка с полной постановкой: claude получает новый ID сессии, opencode сообщит свой сам; у codex сессии нет. */
function freshAttempt(k: Kernel, run: RunFile, prompt: string, systemPrompt: string, onSession?: (id: string) => void) {
  const agent = run.agents.executor;
  setSession(run, agent, agent === 'claude' ? crypto.randomUUID() : undefined);
  return runRole(k, run, 'executor', {
    prompt,
    systemPrompt,
    openspec: true,
    sessionId: agent === 'claude' ? run.executorSession : undefined,
    onSession,
  });
}

/** Сборочные артефакты (tsbuildinfo, next-env.d.ts…), которые агент изменил запуском сборки, — назад к базе: в дифф и коммит они не идут. */
export async function dropArtifacts(k: Kernel, run: RunFile) {
  const tools = await k.tools(['git']).catch(() => null);
  if (!tools) return;
  const git = new Git(tools.git, k.opts.env);
  for (const slot of repoSlots(run)) {
    const changed = await git.changedFiles(slot.worktreePath, slot.base).catch(() => [] as string[]);
    const junk = changed.filter((f) => ARTIFACT_RE.test(f));
    if (!junk.length) continue;
    const shown = junk.map((f) => slotPath(slot, f)).join(', ');
    await git
      .restoreFromBase(slot.worktreePath, slot.base, junk)
      .catch((e) => k.warn(run, `Не удалось откатить сборочные артефакты (${shown}) — они попадут в дифф: ${(e as Error).message}`));
    k.log(run, c.dim(`Откатил сборочные артефакты, которые попали в изменения: ${shown}`) + '\n');
  }
}
