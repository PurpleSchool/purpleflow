import { addUsage, c, emptyUsage, type AgentResult } from '../agents/common.js';
import { Git } from '../git.js';
import { afterReview } from '../route.js';
import { formatItem, originTag } from '../items.js';
import { parseJsonReply } from '../json.js';
import { GENERATED_GLOBS, lineStats, packReview, splitDiff } from '../reviewdiff.js';
import { modeOf } from '../modes.js';
import type { ReviewItem, ReviewResult, RunFile, StageAttempt } from '../types.js';
import { INLINE_DIFF, RUN_JSON_GLOB, STAGE_TITLES, isImageFile, parseReview, parseVerdicts } from '../shared.js';
import type { Orchestrator } from '../orchestrator.js';
/** После прогона: уроки из правок человека, ревью, визуальной проверки и сбоев проверок. В фоне, не задерживает коммит. */
/** Что за круг принимает человек: от этого зависит, как читать дифф. */
export function summaryContext(h: Orchestrator, run: RunFile) : string {
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
export async function summarizeChanges(h: Orchestrator, id: string) {
  const run = h.store.load(id);
  if (!run || run.next !== 'gate2') return;
  const attempt = run.attempts.filter((a) => a.stage === 'gate2').length;
  if (run.changeSummary?.attempt === attempt) return;
  const tools = await h.tools(['git']).catch(() => null);
  if (!tools) return;
  const files = run.roundFiles;
  let diff = await new Git(tools.git, h.opts.env).diffText(run.worktreePath, h.diffBase(run), [RUN_JSON_GLOB, ...h.envFilesOf(run), ...GENERATED_GLOBS]);
  if (files?.length) diff = diff.split(/^(?=diff --git )/m).filter((d) => files.some((f) => d.startsWith(`diff --git a/${f} `))).join('');
  if (!diff.trim()) return;
  // Сводке хватает одной части: код — первым, большие тексты урезаны, остальное — списком.
  const packed = packReview(diff, 60_000, 1);
  diff = (packed.parts[0] ?? '') + (packed.omitted.length ? `\n… ещё файлы, не вошедшие в дифф: ${packed.omitted.join(', ')}\n` : '');
  const res = await h.service({ prompt: h.prompts.render('summary.md', { task: h.taskText(run), context: h.summaryContext(run), diff }), group: `${run.id}:summary`, timeoutMs: 3 * 60_000 }).catch(() => null);
  if (!res?.ok || !res.text.trim()) return;
  // Пока сводка писалась, человек мог уже принять решение — пишем только в ту же приёмку.
  const fresh = h.store.load(id);
  if (!fresh || fresh.next !== 'gate2' || fresh.attempts.filter((a) => a.stage === 'gate2').length !== attempt) return;
  fresh.changeSummary = { at: new Date().toISOString(), text: res.text.trim(), attempt };
  h.save(fresh);
  h.emit({ type: 'run.updated', run: fresh });
}

/** Группы файлов диффа по пунктам плана — считаются к каждой приёмке, если есть tasks.md. */
export async function mapFilesToPlan(h: Orchestrator, id: string) {
  const run = h.store.load(id);
  if (!run || modeOf(run) === 'quick') return;
  const attempt = run.attempts.filter((a) => a.stage === 'gate2').length;
  if (run.taskMap?.attempt === attempt) return;
  const docs = await h.getChangeDocs(id).catch(() => null);
  if (!docs?.tasks.trim()) return;
  const tools = await h.tools(['git']).catch(() => null);
  if (!tools) return;
  const diff = await new Git(tools.git, h.opts.env).diffText(run.worktreePath, h.diffBase(run), [RUN_JSON_GLOB, ...h.envFilesOf(run), ...GENERATED_GLOBS]);
  const files = splitDiff(diff).map((f) => ({ path: f.path, ...lineStats(f.text) })).filter((f) => !f.path.startsWith('openspec/'));
  if (files.length < 4) return;
  const res = await h.service({ prompt: h.prompts.render('plan-map.md', { tasks: docs.tasks.slice(0, 20_000), files: files.map((f) => `- ${f.path} (+${f.add} −${f.del})`).join('\n') }), group: `${run.id}:map`, timeoutMs: 3 * 60_000 }).catch(() => null);
  if (!res?.ok) return;
  let groups: { title: string; files: string[] }[] = [];
  try {
    const j = parseJsonReply<{ groups?: { title?: unknown; files?: unknown }[] }>(res.text);
    if (!j) return;
    const known = new Set(files.map((f) => f.path));
    const used = new Set<string>();
    groups = (j.groups ?? []).map((g) => ({
      title: String(g.title ?? '').trim(),
      files: (Array.isArray(g.files) ? g.files.map(String) : []).filter((f) => known.has(f) && !used.has(f) && (used.add(f), true)),
    })).filter((g) => g.title && g.files.length);
    const rest = files.map((f) => f.path).filter((f) => !used.has(f));
    if (rest.length) groups.push({ title: 'Без пункта плана', files: rest });
  } catch {
    return;
  }
  // Прогон мог уйти дальше, пока считали: сохраняем только к той же приёмке.
  const fresh = h.store.load(id);
  if (!fresh || fresh.attempts.filter((x) => x.stage === 'gate2').length !== attempt || !groups.length) return;
  fresh.taskMap = { attempt, groups };
  h.save(fresh);
}

/**
 * Повторное ревью — продолжение прошлого: ревьюер видит свои блокирующие замечания и ответ исполнителя,
 * чтобы проверить исправления, а не читать большой дифф каждый раз заново и находить новое.
 */
export function previousReviewBlock(h: Orchestrator, run: RunFile) : string {
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
  return h.prompts.render('review-again.md', {
    round: String(round),
    blocking: prev.blocking.map(fmt).join('\n'),
    notes: prev.notes.length ? prev.notes.map(fmt).join('\n') : '(не было)',
    report: (impl.output ?? impl.summary ?? '(исполнитель не оставил отчёта)').slice(0, 4000),
  });
}

export async function stageReview(h: Orchestrator, run: RunFile) {
  const { review } = await h.reviewPass(run);
  if (!review.blocking.length) {
    // Порядок: ревью диффа (дёшево, без окружения) → визуальная проверка → приёмка со свежими скриншотами.
    run.next = afterReview(run);
    run.feedback = undefined;
    h.save(run);
    return;
  }
  run.feedback = { source: 'review', text: h.reviewFeedback(review) };
  h.nextImplementOrLimit(run, `Ревьюер оставил блокирующие замечания, а ${run.implAttemptsUsed} попытки реализации исчерпаны.`);
}

/**
 * Ревью диффа: попытка стадии, агент, разбор ответа, запись в run.reviews. Куда дальше — решает вызывающий.
 * quiet — вывод ревьюера копится и пишется в лог одним куском в конце (ревью идёт параллельно с проверками).
 */
export async function reviewPass(h: Orchestrator, run: RunFile, quiet = false) : Promise<{ review: ReviewResult; log: string }> {
  const tools = await h.tools(['git']);
  let buffered = '';
  // Параллельно с проверками весь лог ревью копится и пишется одним куском: иначе строки двух стадий перемешаются.
  const out = (t: string) => { if (quiet) buffered += t; else h.log(run, t); };
  const attempt = h.begin(run, 'review', run.models.reviewer, quiet);
  const git = new Git(tools.git, h.opts.env);
  // Генерируемое (tsbuildinfo, lock-файлы, сборки) не ревьюим; код — первым; крупный дифф — нескольким ревьюерам.
  const diff = await git.diffText(run.worktreePath, h.diffBase(run), [RUN_JSON_GLOB, ...h.envFilesOf(run), ...GENERATED_GLOBS]);
  // Один ревьюер на весь дифф: он видит стыки модулей, где чаще всего ошибки. Небольшой дифф — в промпт,
  // большой — списком файлов по важности, ревьюер читает их сам (packReview умеет делить на части — пока не делим).
  const packed = packReview(diff, Number.MAX_SAFE_INTEGER, 1);
  const stats = new Map(splitDiff(diff).map((f) => [f.path, lineStats(f.text)]));
  const base8 = run.baseCommit.slice(0, 8);
  // Небольшая часть — прямо в промпт (без лишних шагов); большая — списком файлов: ревьюер читает дифф сам.
  const diffFor = (i: number) => {
    const part = packed.parts[i] ?? '';
    if (!part) return '(изменений кода нет)';
    if (part.length <= INLINE_DIFF) return `Дифф:\n\n\`\`\`diff\n${part}\n\`\`\``;
    const list = packed.files[i].map((f) => {
      const st = stats.get(f);
      return `- \`${f}\`${st ? ` (+${st.add} −${st.del})` : ''}`;
    }).join('\n');
    return `Изменённые файлы — по важности: сначала код, потом тесты, миграции, тексты. Прочитай дифф **каждого** файла из списка (\`git diff ${base8} -- <файл>\`, можно сразу несколько файлов одной командой), а где нужно — и файл целиком. Не пропускай файлы и не ограничивайся первыми — замечания по непрочитанному коду ничего не стоят.\n\n${list}`;
  };
  const docs = await h.getChangeDocs(run.id);
  const lastTest = run.tests[run.tests.length - 1];
  const n = Math.max(1, packed.parts.length);
  const extraFiles = [
    packed.trimmed.length ? `Урезаны до начала (дочитай через \`git diff ${run.baseCommit.slice(0, 8)} -- <файл>\`, если нужно): ${packed.trimmed.map((f) => `\`${f}\``).join(', ')}.` : '',
    packed.omitted.length ? `Не вошли в дифф выше — прочитай их сами через \`git diff ${run.baseCommit.slice(0, 8)} -- <файл>\`: ${packed.omitted.map((f) => `\`${f}\``).join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  if (n > 1) out(c.dim(`Дифф большой — ревью на ${n} ревьюеров параллельно, по модулям.`) + '\n');

  const previous = h.previousReviewBlock(run);
  const promptFor = (i: number) => h.prompts.render('review.md', {
    changeId: run.changeId,
    proposal: docs.proposal || '(нет)',
    tasks: docs.tasks || '(нет)',
    specs: docs.specs.map((s) => `### ${s.path}\n\n${s.content}`).join('\n\n') || '(нет)',
    tests: quiet ? 'идут параллельно с ревью и проверяются отдельно — не запускай их, не оценивай, прошли ли они, и не пиши об этом замечаний' : lastTest ? `\`${lastTest.command || '—'}\`: ${lastTest.passed ? 'прошли' : 'не прошли'}` : 'не запускались',
    base: run.baseCommit.slice(0, 8),
    diff: diffFor(i),
    scope: [
      n > 1 ? `\n## Твоя часть\n\nДифф большой, его делят ${n} ревьюера. Ты смотришь часть ${i + 1} из ${n} — файлы ниже; остальные части смотрят другие. Замечания — по своим файлам; если проблема на стыке с чужим файлом — открой его и тоже напиши. Прошлые замечания по чужим файлам пропусти.\n\n${packed.files[i].map((f) => `- \`${f}\``).join('\n')}\n` : '',
      extraFiles && (n === 1 || i === n - 1) ? `\n${extraFiles}\n` : '',
    ].join(''),
    previous: previous || '\nНайденные блокирующие отдельно проверит второй ревьюер по коду — поэтому не отбрасывай подозрение на ошибку из сомнения: если сценарий поломки правдоподобен, ставь в `blocking` с описанием сценария.\n',
    attachments: [
      run.attachments?.some(isImageFile) ? 'К задаче приложены изображения (макеты, скриншоты) — они прикреплены к этому сообщению. Сверь реализацию с ними.' : '',
      h.filesBlock(run),
      run.visuals?.length ? 'Также прикреплены скриншоты приложения после изменений (визуальная проверка). Учитывай видимый результат.' : '',
    ].filter(Boolean).join('\n'),
  });

  const bufs = new Array<string>(n).fill('');
  const parallel = n > 1 || quiet;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => h.runRole(run, 'reviewer', {
    prompt: promptFor(i),
    ...(parallel ? { onOutput: (t: string) => { bufs[i] += t; } } : {}),
    readOnly: true,
    images: [...(run.attachments ?? []).filter(isImageFile), ...((run.visuals?.at(-1)?.shots ?? []).slice(0, 6).map((x) => x.file))],
    outputSchema: h.prompts.json<object>('review.schema.json'),
  })));
  if (parallel) {
    const head = (i: number) => '\n' + c.violet(c.bold(`━━ ${STAGE_TITLES.review} · попытка ${attempt.attempt}${n > 1 ? ` · часть ${i + 1}/${n}` : ''}`)) + (quiet ? c.dim('  # шло параллельно с проверками') : '') + '\n';
    const text = bufs.map((b, i) => head(i) + b).join('');
    if (quiet) buffered = text + buffered;
    else h.log(run, text, false);
  }
  // Токены всех ревьюеров — в попытку; остановка или сбой любого — как у одного агента.
  const merged: AgentResult = {
    ok: results.every((r) => r.ok),
    stopped: results.some((r) => r.stopped),
    text: '',
    usage: results.reduce((u, r) => addUsage(u, r.usage), emptyUsage()),
    error: results.find((r) => !r.ok)?.error,
  };
  try {
    h.afterAgent(run, attempt, merged);
  } catch (e) {
    if (quiet) h.log(run, buffered, false);
    throw e;
  }

  const parsedAll = results.map((r) => parseReview(r.text));
  const bad = parsedAll.findIndex((x) => !x);
  if (bad >= 0) {
    if (quiet) h.log(run, buffered, false);
    throw new Error(`Ревьюер${n > 1 ? ` (часть ${bad + 1})` : ''} вернул ответ не в формате JSON { blocking, notes }:\n${results[bad].text.slice(0, 500)}`);
  }
  const seen = new Set<string>();
  const uniq = (items: ReviewItem[]) => items.filter((i) => {
    const k = `${i.file ?? ''}:${i.line ?? ''}:${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const parsed = { blocking: uniq(parsedAll.flatMap((x) => x!.blocking)), notes: uniq(parsedAll.flatMap((x) => x!.notes)) };
  // Первое ревью — с проверкой найденного: второй ревьюер подтверждает каждое блокирующее по коду.
  if (!previous && parsed.blocking.length) {
    const verified = await h.verifyBlocking(run, attempt, parsed.blocking, docs.proposal, out);
    parsed.blocking = verified.blocking;
    parsed.notes = [...parsed.notes, ...verified.demoted];
  }
  const review: ReviewResult = { at: new Date().toISOString(), ...parsed };
  run.reviews.push(review);
  h.emit({ type: 'review.result', runId: run.id, result: review });
  if (review.blocking.length) out(c.coral(`✗ блокирующие замечания (${review.blocking.length}):\n`) + review.blocking.map((i) => `  • ${originTag(i)}${formatItem(i)}`).join('\n') + '\n');
  if (review.notes.length) out(c.amber(`• заметки (${review.notes.length}):\n`) + review.notes.map((i) => `  • ${formatItem(i)}`).join('\n') + '\n');
  h.end(run, attempt, review.blocking.length ? 'failed' : 'done', review.blocking.length ? `Блокирующих: ${review.blocking.length}` : `Без блокирующих, заметок: ${review.notes.length}`);

  return { review, log: quiet ? buffered : '' };
}

/** Второй проход ревью: подтвердить каждое блокирующее замечание по коду, ложные — убрать, мелкие — в заметки. */
export async function verifyBlocking(h: Orchestrator, run: RunFile, attempt: StageAttempt, items: ReviewItem[], proposal: string, out: (t: string) => void) : Promise<{ blocking: ReviewItem[]; demoted: ReviewItem[] }> {
  const fmt = (i: ReviewItem) => formatItem(i, true);
  let buf = '';
  const res = await h.runRole(run, 'reviewer', {
    prompt: h.prompts.render('review-verify.md', {
      changeId: run.changeId,
      base: run.baseCommit.slice(0, 8),
      proposal: `${h.taskText(run)}\n\n${proposal || ''}`.slice(0, 20_000),
      items: items.map((x, k) => `${k + 1}. ${fmt(x)}`).join('\n'),
    }),
    readOnly: true,
    onOutput: (t) => { buf += t; },
    outputSchema: h.prompts.json<object>('review-verify.schema.json'),
  });
  h.afterAgent(run, attempt, res);
  out('\n' + c.dim(`— проверка ${items.length} блокирующих замечаний вторым ревьюером —`) + '\n' + buf);
  const verdicts = parseVerdicts(res.text);
  // Ответ не разобрали — оставляем как есть: лучше лишнее замечание, чем пропущенная ошибка.
  if (!verdicts) return { blocking: items, demoted: [] };
  const blocking: ReviewItem[] = [];
  const demoted: ReviewItem[] = [];
  items.forEach((x, k) => {
    const v = verdicts.find((d) => d.index === k + 1);
    if (!v || v.verdict === 'confirmed') blocking.push(v?.reason ? { ...x, message: `${x.message}\n\nСценарий: ${v.reason}` } : x);
    else if (v.verdict === 'minor') demoted.push({ ...x, message: `${x.message} (второй ревьюер: не блокирует — ${v.reason})` });
    else out(c.dim(`  ✗ отклонено: ${fmt(x)} — ${v.reason}`) + '\n');
  });
  out(c.dim(`подтверждено ${blocking.length} из ${items.length}${demoted.length ? `, в заметки — ${demoted.length}` : ''}`) + '\n');
  return { blocking, demoted };
}

export function reviewFeedback(h: Orchestrator, review: ReviewResult) : string {
  return 'Ревьюер (другая модель) нашёл блокирующие проблемы. Исправь каждую по существу — не выключай проверку, не прячи поведение за флагом и не ослабляй требование спецификации; если по существу исправить нельзя, так и напиши в отчёте, почему:\n' + review.blocking.map((i) => `- ${originTag(i)}${formatItem(i)}`).join('\n')
    + (review.notes.length ? '\n\nНеобязательные заметки:\n' + review.notes.map((i) => `- ${formatItem(i)}`).join('\n') : '');
}
