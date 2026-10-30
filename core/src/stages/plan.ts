// Стадии «Уточнение» и «План»: вопросы к человеку, proposal/tasks/specs от планировщика и валидация OpenSpec.
import fs from 'node:fs';
import path from 'node:path';
import { c } from '../agents/common.js';
import type { Kernel } from '../kernel.js';

import { OpenSpec } from '../openspec.js';
import { countPhases, firstLine, parseFocusTests, parseQuestions, planTitle } from '../parse.js';
import { PLAN_RETRIES } from '../runtime.js';
import { runRole } from '../services/agents.js';
import { attachmentsBlock } from '../services/attachments.js';
import { ensureProfile } from '../services/projects.js';
import { feedbackBlock, modeRules, taskText } from '../services/prompting.js';
import { getChangeDocs } from '../services/runs.js';
import type { RunFile } from '../types.js';
import { captureBaseChecks, flushBaseChecks, runChecks, settleBaseChecks, startBaseChecks } from './checks.js';
export async function stageClarify(k: Kernel, run: RunFile) {
  startBaseChecks(k, run);
  const attempt = k.begin(run, 'clarify', run.models.planner);
  // Профиль проекта собирается один раз — дальше его получают все агенты.
  await ensureProfile(k, run, attempt);
  const prompt = k.prompts.render('clarify.md', { task: run.task, attachments: attachmentsBlock(k, run) });
  const res = await runRole(k, run, 'planner', { prompt, readOnly: true, outputSchema: k.prompts.json<object>('clarify.schema.json') });
  k.afterAgent(run, attempt, res);
  const questions = parseQuestions(res.text);
  if (!questions.length) {
    k.end(run, attempt, 'done', 'Задача понятна — вопросов нет');
    run.next = 'plan';
    k.save(run);
    return;
  }
  flushBaseChecks(k, run);
  run.clarify = { questions };
  k.log(
    run,
    c.amber(`? вопросы планировщика (${questions.length}):\n`) +
      questions.map((q, i) => `  ${i + 1}. ${q.q}${q.options?.length ? c.dim(` [${q.options.join(' / ')}]`) : ''}`).join('\n') +
      '\n',
  );
  k.end(run, attempt, 'done', `Вопросов: ${questions.length}`);
  run.next = 'gate0';
  k.save(run);
}

export async function answer(k: Kernel, id: string, answers: { q: string; a: string }[]) {
  const r = k.mustLoad(id);
  if (r.next !== 'gate0' || (r.status !== 'waiting' && r.status !== 'stopped')) throw new Error('Прогон не ждёт ответов на вопросы');
  const clean = answers.map((x) => ({ q: x.q.trim(), a: x.a.trim() })).filter((x) => x.a);
  r.clarify = { questions: r.clarify?.questions ?? [], answers: clean, skipped: clean.length ? undefined : true };
  r.gates.push({
    gate: 'gate0',
    at: new Date().toISOString(),
    decision: 'approve',
    comment: clean.map((x) => `${x.q} — ${x.a}`).join('\n') || undefined,
  });
  const gateAttempt = [...r.attempts].reverse().find((a) => a.stage === 'gate0' && a.status === 'running');
  if (gateAttempt)
    Object.assign(gateAttempt, {
      status: 'done',
      endedAt: new Date().toISOString(),
      summary: clean.length ? `Ответов: ${clean.length}` : 'Без ответов',
    });
  if (clean.length) k.log(r, c.mint('✓ ответы человека:\n') + clean.map((x) => `  • ${x.q} — ${x.a}`).join('\n') + '\n');
  r.message = undefined;
  r.next = 'plan';
  r.status = 'running';
  k.save(r);
  void k.engine.drive(r);
}

export async function stagePlan(k: Kernel, run: RunFile) {
  // Новый план — новая постановка: прошлая сессия исполнителя к нему не относится.
  run.executorSession = undefined;
  const tools = await k.tools(['openspec']);
  const attempt = k.begin(run, 'plan', run.models.planner);

  // Подготовка и линтер до правок шли в фоне с уточнения — здесь их дожидаемся (или делаем, если фона не было).
  // Тесты в эталон — после плана: план выберет, какие из них касаются задачи.
  await settleBaseChecks(k, run);
  await captureBaseChecks(k, run, false);

  const prompt = k.prompts.render('plan.md', {
    changeId: run.changeId,
    task: taskText(k, run),
    attachments: attachmentsBlock(k, run),
    testCommand: run.testCommand || 'не задана',
    feedback: feedbackBlock(k, run.feedback),
  });
  const res = await runRole(k, run, 'planner', {
    prompt,
    systemPrompt: k.prompts.raw('planner.system.md') + modeRules(k, 'planner', run),
    openspec: true,
  });
  k.afterAgent(run, attempt, res);

  const mode = run.mode;
  const changeDir = path.join(run.worktreePath, 'openspec', 'changes', run.changeId);
  if (mode === 'refactor' && fs.existsSync(changeDir)) {
    // Рефакторинг не меняет поведение: изменение без дельт спецификаций.
    fs.writeFileSync(path.join(changeDir, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  }
  const openspec = new OpenSpec(tools.openspec, k.opts.env);
  const v = await openspec.validate(run.worktreePath, run.changeId, run.id);
  k.checkStop(run);
  if (v.valid && mode === 'epic' && !fs.existsSync(path.join(changeDir, 'design.md'))) {
    v.valid = false;
    v.issues.push({
      level: 'ERROR',
      message: 'Для большой задачи нужен design.md: варианты решения, выбранный подход и разбиение на этапы.',
    });
  }
  if (v.valid && mode === 'epic') {
    run.phases = Math.max(1, Math.min(8, countPhases((await getChangeDocs(k, run.id)).tasks)));
  }
  if (v.valid) {
    const focus = parseFocusTests((await getChangeDocs(k, run.id)).proposal);
    run.focusTestCommand = focus && run.testCommand && focus !== run.testCommand ? focus : undefined;
    if (run.focusTestCommand)
      k.log(run, c.dim(`Тесты задачи: \`${run.focusTestCommand}\` — на каждой попытке; полный набор — перед приёмкой.`) + '\n');
  }
  if (v.valid && mode === 'bug') {
    // Воспроизведение засчитано, только если проверки на текущем коде красные.
    k.log(run, c.dim('Проверяем, что баг воспроизведён: проверки должны упасть…') + '\n');
    const { result } = await runChecks(k, run, run.focusTestCommand || run.testCommand);
    run.repro = result;
    if (!result.checks?.length) {
      v.valid = false;
      v.issues.push({
        level: 'ERROR',
        message: 'Не заданы команды тестов — воспроизвести баг тестом нельзя. Укажите команду тестов в командах проекта.',
      });
    } else if (result.passed) {
      v.valid = false;
      v.issues.push({
        level: 'ERROR',
        message: `Тест воспроизведения не падает: все проверки зелёные на текущем коде${run.focusTestCommand ? ` (запускалась команда из «## Checks»: \`${run.focusTestCommand}\` — она должна включать тест воспроизведения)` : ''}. Напиши тест, который падает именно из-за бага.`,
      });
    } else {
      k.log(run, c.mint('✓ баг воспроизведён: проверки красные, как и ожидалось') + '\n');
    }
  }
  if (v.valid) {
    k.log(run, c.mint('✓ openspec validate: изменение валидно') + '\n');
    const proposal = (await getChangeDocs(k, run.id)).proposal;
    const title = planTitle(proposal);
    // Планировщик разбил большую задачу: этот план — первая часть, остальное — в «Next Parts».
    run.nextParts = /^##\s+Next Parts/m.test(proposal) || undefined;
    if (title) {
      run.title = title;
      run.titleFromPlan = true;
    }
    k.end(run, attempt, 'done', firstLine(res.text) || 'План готов');
    run.feedback = undefined;
    run.planRetries = 0;
    run.next = 'gate1';
    k.save(run);
    // Пока человек читает план, тесты задачи снимаются на коде до правок.
    startBaseChecks(k, run, 'plan');
    return;
  }
  const issues = v.issues.map((i) => `- [${i.level}] ${i.path ? i.path + ': ' : ''}${i.message}`).join('\n');
  k.log(run, c.coral('✗ openspec validate:\n' + issues) + '\n');
  k.end(run, attempt, 'failed', 'План не прошёл валидацию', issues);
  if (run.planRetries < PLAN_RETRIES) {
    run.planRetries++;
    run.feedback = { source: 'validator', text: `\`openspec validate ${run.changeId} --strict\` нашёл ошибки:\n${issues}` };
    run.next = 'plan';
    k.save(run);
    return;
  }
  run.feedback = { source: 'validator', text: `\`openspec validate ${run.changeId} --strict\` нашёл ошибки:\n${issues}` };
  k.markStopped(
    run,
    `План не прошёл openspec validate после ${PLAN_RETRIES + 1} попыток. Исправьте файлы вручную или нажмите «Продолжить».`,
  );
}

/**
 * С чего начать исполнителю: файлы, которые план называет в proposal и tasks.md, — чтобы не изучать проект заново.
 * Профиль проекта у него и так в системном промпте.
 */
export async function startFilesBlock(k: Kernel, run: RunFile): Promise<string> {
  if (run.mode === 'quick') return '';
  const docs = await getChangeDocs(k, run.id).catch(() => null);
  if (!docs) return '';
  const text = `${docs.proposal}\n${docs.tasks}`;
  const paths = new Set<string>();
  for (const m of text.matchAll(/`?((?:[\w.@-]+\/)+[\w.@-]+\.[a-zA-Z0-9]{1,6})`?/g)) {
    const p = m[1].replace(/^\.\//, '');
    if (!p.startsWith('openspec/') && !p.includes('..')) paths.add(p);
  }
  if (!paths.size) return '';
  const list = [...paths]
    .slice(0, 60)
    .map((p) => `- \`${p}\`${fs.existsSync(path.join(run.worktreePath, p)) ? '' : ' (новый)'}`)
    .join('\n');
  return `\nФайлы, которые называет план, — начни с них и их соседей; весь проект заново не изучай (профиль проекта — в системном промпте):\n${list}\n`;
}
