// Стадия «Ревью»: независимый ревьюер, перепроверка блокирующих замечаний, сводка изменений и карта плана.
import { c } from '../agents/common.js';
import { isImageFile } from '../files.js';
import { Git } from '../git.js';
import { formatItem, originTag } from '../items.js';
import { parseJsonReply } from '../json.js';
import type { Kernel } from '../kernel.js';

import { parseReview, parseVerdicts } from '../parse.js';
import { GENERATED_GLOBS, lineStats, packReview, splitDiff } from '../reviewdiff.js';
import { afterReview } from '../route.js';
import { INLINE_DIFF, RUN_JSON_GLOB } from '../runtime.js';
import { runRole, service } from '../services/agents.js';
import { filesBlock } from '../services/attachments.js';
import { taskText } from '../services/prompting.js';
import { getChangeDocs } from '../services/runs.js';
import { diffBase, envFilesOf } from '../services/workspace.js';
import { STAGE_TITLES } from '../stage-info.js';
import type { ReviewItem, ReviewResult, RunFile, StageAttempt } from '../types.js';
/** После прогона: уроки из правок человека, ревью, визуальной проверки и сбоев проверок. В фоне, не задерживает коммит. */
/** Что за круг принимает человек: от этого зависит, как читать дифф. */
export function summaryContext(k: Kernel, run: RunFile): string {
  const round = run.prRound ? run.prRounds?.at(-1) : undefined;
  if (round?.kind === 'update') {
    return `\nВажно: это не новая работа по задаче. В ветку задачи влита свежая ${run.pr?.base ?? 'базовая ветка'}, в файлах были конфликты, и агент их разрешил. Дифф — изменения этих файлов от состояния ветки до слияния: код, пришедший из ${run.pr?.base ?? 'базовой ветки'}, — это не отклонение от задачи. Опиши, что пришло из базовой ветки и как разрешены конфликты; проверь, что сохранены обе стороны и не осталось маркеров конфликта.\n`;
  }
  if (round) {
    return `\nВажно: задача уже сделана, это круг доработки по замечаниям ревьюеров в PR. Дифф — только правки этого круга. Замечания:\n${round.items.map((i) => `- ${i.kind === 'check' ? `упала проверка CI «${i.body}»` : `${i.path ? `${i.path}: ` : ''}${i.body.slice(0, 300)}`}`).join('\n')}${round.note ? `\n- комментарий человека: ${round.note}` : ''}\nВ «Что сделано» опиши, как отработано каждое замечание; в «На что посмотреть» — замечания, которые не отработаны или отработаны не полностью.\n`;
  }
  return '';
}

/** «Что изменилось»: короткая сводка диффа для приёмки — в фоне, приёмку не задерживает. */
export async function summarizeChanges(k: Kernel, id: string) {
  const run = k.store.load(id);
  if (!run || run.next !== 'gate2') return;
  const attempt = run.attempts.filter((a) => a.stage === 'gate2').length;
  if (run.changeSummary?.attempt === attempt) return;
  const tools = await k.tools(['git']).catch(() => null);
  if (!tools) return;
  const files = run.roundFiles;
  let diff = await new Git(tools.git, k.opts.env).diffText(run.worktreePath, diffBase(k, run), [
    RUN_JSON_GLOB,
    ...envFilesOf(k, run),
    ...GENERATED_GLOBS,
  ]);
  if (files?.length)
    diff = diff
      .split(/^(?=diff --git )/m)
      .filter((d) => files.some((f) => d.startsWith(`diff --git a/${f} `)))
      .join('');
  if (!diff.trim()) return;
  // Сводке хватает одной части: код — первым, большие тексты урезаны, остальное — списком.
  const packed = packReview(diff, 60_000, 1);
  diff = (packed.parts[0] ?? '') + (packed.omitted.length ? `\n… ещё файлы, не вошедшие в дифф: ${packed.omitted.join(', ')}\n` : '');
  const res = await service(k, {
    prompt: k.prompts.render('summary.md', { task: taskText(k, run), context: summaryContext(k, run), diff }),
    group: `${run.id}:summary`,
    timeoutMs: 3 * 60_000,
  }).catch(() => null);
  if (!res?.ok || !res.text.trim()) return;
  // Пока сводка писалась, человек мог уже принять решение — пишем только в ту же приёмку.
  const fresh = k.store.load(id);
  if (!fresh || fresh.next !== 'gate2' || fresh.attempts.filter((a) => a.stage === 'gate2').length !== attempt) return;
  fresh.changeSummary = { at: new Date().toISOString(), text: res.text.trim(), attempt };
  k.save(fresh);
  k.emit({ type: 'run.updated', run: fresh });
}

/** Группы файлов диффа по пунктам плана — считаются к каждой приёмке, если есть tasks.md. */
export async function mapFilesToPlan(k: Kernel, id: string) {
  const run = k.store.load(id);
  if (!run || run.mode === 'quick') return;
  const attempt = run.attempts.filter((a) => a.stage === 'gate2').length;
  if (run.taskMap?.attempt === attempt) return;
  const docs = await getChangeDocs(k, id).catch(() => null);
  if (!docs?.tasks.trim()) return;
  const tools = await k.tools(['git']).catch(() => null);
  if (!tools) return;
  const diff = await new Git(tools.git, k.opts.env).diffText(run.worktreePath, diffBase(k, run), [
    RUN_JSON_GLOB,
    ...envFilesOf(k, run),
    ...GENERATED_GLOBS,
  ]);
  const files = splitDiff(diff)
    .map((f) => ({ path: f.path, ...lineStats(f.text) }))
    .filter((f) => !f.path.startsWith('openspec/'));
  if (files.length < 4) return;
  const res = await service(k, {
    prompt: k.prompts.render('plan-map.md', {
      tasks: docs.tasks.slice(0, 20_000),
      files: files.map((f) => `- ${f.path} (+${f.add} −${f.del})`).join('\n'),
    }),
    group: `${run.id}:map`,
    timeoutMs: 3 * 60_000,
  }).catch(() => null);
  if (!res?.ok) return;
  let groups: { title: string; files: string[] }[];
  try {
    const j = parseJsonReply<{ groups?: { title?: unknown; files?: unknown }[] }>(res.text);
    if (!j) return;
    const known = new Set(files.map((f) => f.path));
    const used = new Set<string>();
    groups = (j.groups ?? [])
      .map((g) => ({
        title: String(g.title ?? '').trim(),
        files: (Array.isArray(g.files) ? g.files.map(String) : []).filter((f) => known.has(f) && !used.has(f) && (used.add(f), true)),
      }))
      .filter((g) => g.title && g.files.length);
    const rest = files.map((f) => f.path).filter((f) => !used.has(f));
    if (rest.length) groups.push({ title: 'Без пункта плана', files: rest });
  } catch {
    return;
  }
  // Прогон мог уйти дальше, пока считали: сохраняем только к той же приёмке.
  const fresh = k.store.load(id);
  if (!fresh || fresh.attempts.filter((x) => x.stage === 'gate2').length !== attempt || !groups.length) return;
  fresh.taskMap = { attempt, groups };
  k.save(fresh);
}

/**
 * Повторное ревью — продолжение прошлого: ревьюер видит свои блокирующие замечания и ответ исполнителя,
 * чтобы проверить исправления, а не читать большой дифф каждый раз заново и находить новое.
 */
export function previousReviewBlock(k: Kernel, run: RunFile): string {
  const prev = run.reviews.at(-1);
  if (!prev?.blocking.length) return '';
  const reviewAt = Date.parse(prev.at);
  const impl = [...run.attempts].reverse().find((a) => a.stage === 'implement' && a.status === 'done');
  if (!impl || Date.parse(impl.startedAt) < reviewAt) return '';
  // После возврата к плану прошлые замечания относятся к старому плану — ревью с чистого листа.
  const replan = run.interventions?.filter((i) => i.kind === 'replan').at(-1);
  if (replan && Date.parse(replan.at) > reviewAt) return '';
  const fmt = (i: ReviewItem) => `- ${formatItem(i, true)}`;
  const round = run.reviews.filter((r) => r.blocking.length).length + 1;
  return k.prompts.render('review-again.md', {
    round: String(round),
    blocking: prev.blocking.map(fmt).join('\n'),
    notes: prev.notes.length ? prev.notes.map(fmt).join('\n') : '(не было)',
    report: (impl.output ?? impl.summary ?? '(исполнитель не оставил отчёта)').slice(0, 4000),
  });
}

export async function stageReview(k: Kernel, run: RunFile) {
  const { review } = await reviewPass(k, run);
  if (!review.blocking.length) {
    // Порядок: ревью диффа (дёшево, без окружения) → визуальная проверка → приёмка со свежими скриншотами.
    run.next = afterReview(run);
    run.feedback = undefined;
    k.save(run);
    return;
  }
  run.feedback = { source: 'review', text: reviewFeedback(k, review) };
  k.nextImplementOrLimit(run, `Ревьюер оставил блокирующие замечания, а ${run.implAttemptsUsed} попытки реализации исчерпаны.`);
}

/**
 * Ревью диффа: попытка стадии, агент, разбор ответа, запись в run.reviews. Куда дальше — решает вызывающий.
 * quiet — вывод ревьюера копится и пишется в лог одним куском в конце (ревью идёт параллельно с проверками).
 */
export async function reviewPass(k: Kernel, run: RunFile, quiet = false): Promise<{ review: ReviewResult; log: string }> {
  const tools = await k.tools(['git']);
  let buffered = '';
  // Параллельно с проверками весь лог ревью копится и пишется одним куском: иначе строки двух стадий перемешаются.
  const out = (t: string) => {
    if (quiet) buffered += t;
    else k.log(run, t);
  };
  const attempt = k.begin(run, 'review', run.models.reviewer, quiet);
  const git = new Git(tools.git, k.opts.env);
  // Генерируемое (tsbuildinfo, lock-файлы, сборки) не ревьюим; код — первым; крупный дифф — нескольким ревьюерам.
  const diff = await git.diffText(run.worktreePath, diffBase(k, run), [RUN_JSON_GLOB, ...envFilesOf(k, run), ...GENERATED_GLOBS]);
  // Один ревьюер на весь дифф: он видит стыки модулей, где чаще всего ошибки. Небольшой дифф — в промпт,
  // большой — списком файлов по важности, ревьюер читает их сам (packReview умеет делить на части — пока не делим).
  const packed = packReview(diff, Number.MAX_SAFE_INTEGER, 1);
  const stats = new Map(splitDiff(diff).map((f) => [f.path, lineStats(f.text)]));
  const base8 = run.baseCommit.slice(0, 8);
  // Небольшая часть — прямо в промпт (без лишних шагов); большая — списком файлов: ревьюер читает дифф сам.
  const diffFor = () => {
    const part = packed.parts[0] ?? '';
    if (!part) return '(изменений кода нет)';
    if (part.length <= INLINE_DIFF) return `Дифф:\n\n\`\`\`diff\n${part}\n\`\`\``;
    const list = packed.files[0]
      .map((f) => {
        const st = stats.get(f);
        return `- \`${f}\`${st ? ` (+${st.add} −${st.del})` : ''}`;
      })
      .join('\n');
    return `Изменённые файлы — по важности: сначала код, потом тесты, миграции, тексты. Прочитай дифф **каждого** файла из списка (\`git diff ${base8} -- <файл>\`, можно сразу несколько файлов одной командой), а где нужно — и файл целиком. Не пропускай файлы и не ограничивайся первыми — замечания по непрочитанному коду ничего не стоят.\n\n${list}`;
  };
  const docs = await getChangeDocs(k, run.id);
  const lastTest = run.tests[run.tests.length - 1];
  const extraFiles = [
    packed.trimmed.length
      ? `Урезаны до начала (дочитай через \`git diff ${run.baseCommit.slice(0, 8)} -- <файл>\`, если нужно): ${packed.trimmed.map((f) => `\`${f}\``).join(', ')}.`
      : '',
    packed.omitted.length
      ? `Не вошли в дифф выше — прочитай их сами через \`git diff ${run.baseCommit.slice(0, 8)} -- <файл>\`: ${packed.omitted.map((f) => `\`${f}\``).join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const previous = previousReviewBlock(k, run);
  const prompt = k.prompts.render('review.md', {
    changeId: run.changeId,
    proposal: docs.proposal || '(нет)',
    tasks: docs.tasks || '(нет)',
    specs: docs.specs.map((s) => `### ${s.path}\n\n${s.content}`).join('\n\n') || '(нет)',
    tests: quiet
      ? 'идут параллельно с ревью и проверяются отдельно — не запускай их, не оценивай, прошли ли они, и не пиши об этом замечаний'
      : lastTest
        ? `\`${lastTest.command || '—'}\`: ${lastTest.passed ? 'прошли' : 'не прошли'}`
        : 'не запускались',
    base: run.baseCommit.slice(0, 8),
    diff: diffFor(),
    scope: extraFiles ? `\n${extraFiles}\n` : '',
    previous:
      previous ||
      '\nНайденные блокирующие отдельно проверит второй ревьюер по коду — поэтому не отбрасывай подозрение на ошибку из сомнения: если сценарий поломки правдоподобен, ставь в `blocking` с описанием сценария.\n',
    attachments: [
      run.attachments?.some(isImageFile)
        ? 'К задаче приложены изображения (макеты, скриншоты) — они прикреплены к этому сообщению. Сверь реализацию с ними.'
        : '',
      filesBlock(k, run),
      run.visuals?.length
        ? 'Также прикреплены скриншоты приложения после изменений (визуальная проверка). Учитывай видимый результат.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  let buf = '';
  const res = await runRole(k, run, 'reviewer', {
    prompt,
    // Параллельно с проверками вывод копим, чтобы не перемешать с их журналом.
    ...(quiet
      ? {
          onOutput: (t: string) => {
            buf += t;
          },
        }
      : {}),
    readOnly: true,
    images: [...(run.attachments ?? []).filter(isImageFile), ...(run.visuals?.at(-1)?.shots ?? []).slice(0, 6).map((x) => x.file)],
    outputSchema: k.prompts.json<object>('review.schema.json'),
  });
  if (quiet) {
    const head = c.violet(c.bold(`━━ ${STAGE_TITLES.review} · попытка ${attempt.attempt}`)) + c.dim('  # шло параллельно с проверками');
    buffered = `\n${head}\n${buf}${buffered}`;
  }
  try {
    k.afterAgent(run, attempt, { ...res, text: '' });
  } catch (e) {
    if (quiet) k.log(run, buffered, false);
    throw e;
  }

  const reply = parseReview(res.text);
  if (!reply) {
    if (quiet) k.log(run, buffered, false);
    throw new Error(`Ревьюер вернул ответ не в формате JSON { blocking, notes }:\n${res.text.slice(0, 500)}`);
  }
  const seen = new Set<string>();
  const uniq = (items: ReviewItem[]) =>
    items.filter((i) => {
      const key = `${i.file ?? ''}:${i.line ?? ''}:${i.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const parsed = { blocking: uniq(reply.blocking), notes: uniq(reply.notes) };
  // Первое ревью — с проверкой найденного: второй ревьюер подтверждает каждое блокирующее по коду.
  if (!previous && parsed.blocking.length) {
    const verified = await verifyBlocking(k, run, attempt, parsed.blocking, docs.proposal, out);
    parsed.blocking = verified.blocking;
    parsed.notes = [...parsed.notes, ...verified.demoted];
  }
  const review: ReviewResult = { at: new Date().toISOString(), ...parsed };
  run.reviews.push(review);
  k.emit({ type: 'review.result', runId: run.id, result: review });
  if (review.blocking.length)
    out(
      c.coral(`✗ блокирующие замечания (${review.blocking.length}):\n`) +
        review.blocking.map((i) => `  • ${originTag(i)}${formatItem(i)}`).join('\n') +
        '\n',
    );
  if (review.notes.length)
    out(c.amber(`• заметки (${review.notes.length}):\n`) + review.notes.map((i) => `  • ${formatItem(i)}`).join('\n') + '\n');
  k.end(
    run,
    attempt,
    review.blocking.length ? 'failed' : 'done',
    review.blocking.length ? `Блокирующих: ${review.blocking.length}` : `Без блокирующих, заметок: ${review.notes.length}`,
  );

  return { review, log: quiet ? buffered : '' };
}

/** Второй проход ревью: подтвердить каждое блокирующее замечание по коду, ложные — убрать, мелкие — в заметки. */
export async function verifyBlocking(
  k: Kernel,
  run: RunFile,
  attempt: StageAttempt,
  items: ReviewItem[],
  proposal: string,
  out: (t: string) => void,
): Promise<{ blocking: ReviewItem[]; demoted: ReviewItem[] }> {
  const fmt = (i: ReviewItem) => formatItem(i, true);
  let buf = '';
  const res = await runRole(k, run, 'reviewer', {
    prompt: k.prompts.render('review-verify.md', {
      changeId: run.changeId,
      base: run.baseCommit.slice(0, 8),
      proposal: `${taskText(k, run)}\n\n${proposal || ''}`.slice(0, 20_000),
      items: items.map((x, i) => `${i + 1}. ${fmt(x)}`).join('\n'),
    }),
    readOnly: true,
    onOutput: (t) => {
      buf += t;
    },
    outputSchema: k.prompts.json<object>('review-verify.schema.json'),
  });
  k.afterAgent(run, attempt, res);
  out('\n' + c.dim(`— проверка ${items.length} блокирующих замечаний вторым ревьюером —`) + '\n' + buf);
  const verdicts = parseVerdicts(res.text);
  // Ответ не разобрали — оставляем как есть: лучше лишнее замечание, чем пропущенная ошибка.
  if (!verdicts) return { blocking: items, demoted: [] };
  const blocking: ReviewItem[] = [];
  const demoted: ReviewItem[] = [];
  items.forEach((x, i) => {
    const v = verdicts.find((d) => d.index === i + 1);
    if (!v || v.verdict === 'confirmed') blocking.push(v?.reason ? { ...x, message: `${x.message}\n\nСценарий: ${v.reason}` } : x);
    else if (v.verdict === 'minor') demoted.push({ ...x, message: `${x.message} (второй ревьюер: не блокирует — ${v.reason})` });
    else out(c.dim(`  ✗ отклонено: ${fmt(x)} — ${v.reason}`) + '\n');
  });
  out(c.dim(`подтверждено ${blocking.length} из ${items.length}${demoted.length ? `, в заметки — ${demoted.length}` : ''}`) + '\n');
  return { blocking, demoted };
}

export function reviewFeedback(k: Kernel, review: ReviewResult): string {
  return (
    'Ревьюер (другая модель) нашёл блокирующие проблемы. Исправь каждую по существу — не выключай проверку, не прячи поведение за флагом и не ослабляй требование спецификации; если по существу исправить нельзя, так и напиши в отчёте, почему:\n' +
    review.blocking.map((i) => `- ${originTag(i)}${formatItem(i)}`).join('\n') +
    (review.notes.length ? '\n\nНеобязательные заметки:\n' + review.notes.map((i) => `- ${formatItem(i)}`).join('\n') : '')
  );
}
