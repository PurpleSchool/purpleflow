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
import { diffBase } from '../services/workspace.js';
import type { RunFile } from '../types.js';
import { captureBaseChecks, settleBaseChecks } from './checks.js';
import { startFilesBlock } from './plan.js';
export async function stageImplement(k: Kernel, run: RunFile) {
  // Быстрая правка идёт без плана: исходные проверки снимаем перед первой реализацией —
  // только пока агент ещё ничего не менял (у прогонов, начатых до этой версии, эталона нет).
  if (!run.attempts.some((x) => x.stage === 'implement')) {
    // Тесты задачи снимались в фоне, пока человек смотрел план, — дожидаемся; чего нет — снимаем здесь.
    if (run.mode !== 'quick') await settleBaseChecks(k, run);
    await captureBaseChecks(k, run);
  }
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
  const onClaude = run.agents.executor === 'claude';
  const related = await relatedState(k, run.projectPath);
  try {
    // Следующая попытка на claude продолжает сессию прошлой: только замечания, без повторного изучения проекта.
    if (onClaude && run.executorSession) {
      k.log(run, c.dim('продолжаю сессию исполнителя — в контексте прошлая попытка') + '\n');
      const short = k.prompts.render('implement-continue.md', {
        changeId: run.changeId,
        testCommand: run.testCommand || 'не задана',
        attempt: run.implAttemptsUsed,
        limit: run.implAttemptsLimit,
        feedback: phaseBlock(k, run) + feedbackBlock(k, run.feedback),
      });
      res = await runRole(k, run, 'executor', { prompt: short, systemPrompt, openspec: true, resume: run.executorSession });
      if (!res.ok && !res.stopped && /no conversation|session|не найден/i.test(res.error ?? '')) {
        // Сессия пропала (чистка ~/.claude, другой компьютер) — начинаем заново с полной постановкой.
        k.log(run, c.dim('сессия не найдена — начинаю заново') + '\n');
        run.executorSession = crypto.randomUUID();
        res = await runRole(k, run, 'executor', { prompt, systemPrompt, openspec: true, sessionId: run.executorSession });
      }
    } else {
      if (onClaude) run.executorSession = crypto.randomUUID();
      res = await runRole(k, run, 'executor', {
        prompt,
        systemPrompt,
        openspec: true,
        sessionId: onClaude ? run.executorSession : undefined,
      });
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

/** Сборочные артефакты (tsbuildinfo, next-env.d.ts…), которые агент изменил запуском сборки, — назад к базе: в дифф и коммит они не идут. */
export async function dropArtifacts(k: Kernel, run: RunFile) {
  const tools = await k.tools(['git']).catch(() => null);
  if (!tools) return;
  const git = new Git(tools.git, k.opts.env);
  const changed = await git.changedFiles(run.worktreePath, diffBase(k, run)).catch(() => [] as string[]);
  const junk = changed.filter((f) => ARTIFACT_RE.test(f));
  if (!junk.length) return;
  await git
    .restoreFromBase(run.worktreePath, diffBase(k, run), junk)
    .catch((e) =>
      k.warn(run, `Не удалось откатить сборочные артефакты (${junk.join(', ')}) — они попадут в дифф: ${(e as Error).message}`),
    );
  k.log(run, c.dim(`Откатил сборочные артефакты, которые попали в изменения: ${junk.join(', ')}`) + '\n');
}
