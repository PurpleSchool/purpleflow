import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert, CircleCheck, CircleStop, ClipboardCheck, FolderOpen, GitBranch, Hand, Play, RotateCcw, ShieldAlert, Sparkles, UserRoundCheck, X,
} from 'lucide-react';
import type { DiffFile, LineComment, RunFile, StageId } from '@psflow/core';
import { STAGE_ICON, StageRail } from '../components/StageRail';
import { PillTabs } from '../components/PillTabs';
import { TimelinePanel, useNow } from '../components/Timeline';
import { isGate } from '../lib/bars';
import { STAGES } from '../lib/stages';
import { activeClock, ms } from '../lib/clock';
import { LiveLog, type LogSlice } from '../components/Terminal';
import { Markdown } from '../components/Markdown';
import { DiffReview } from '../components/DiffReview';
import { Button, Empty, StatusPill, TextArea } from '../components/ui';
import { onCoreEvent, useStore } from '../lib/store';
import { cost, duration, shortPath, tokens, usageTotal } from '../lib/format';
import type { ChangeDocs } from '../../../shared/ipc';

type View = 'stage' | 'timeline' | 'log';

/** Заголовок попытки в файле лога (orchestrator STAGE_TITLES). */
const LOG_TITLE: Partial<Record<StageId, string>> = { implement: 'Реализация', finish: 'Завершение' };

/** Стадия, на которой прогон сейчас (или итоговая — для завершённого). */
function currentStage(run: RunFile): StageId {
  if (run.status === 'finished') return 'gate2';
  if (run.next === 'limit') {
    const last = [...run.attempts].reverse().find((a) => a.stage === 'tests' || a.stage === 'review');
    return last?.stage ?? 'tests';
  }
  return run.next;
}

const cleanErr = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function RunScreen({ runId }: { runId: string }) {
  const { state, loadRun } = useStore();
  const run = state.details[runId];
  const [view, setView] = useState<View>('stage');
  const [stage, setStage] = useState<StageId>('plan');
  /** Следить за текущей стадией: панель сама переключается, когда прогон идёт дальше. */
  const [follow, setFollow] = useState(true);
  /** Выбранная попытка стадии; null — последняя. */
  const [attemptNo, setAttemptNo] = useState<number | null>(null);
  const [docs, setDocs] = useState<ChangeDocs | null>(null);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [lineComments, setLineComments] = useState<LineComment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadRun(runId);
    setView('stage');
    setFollow(true);
    setAttemptNo(null);
    setDocs(null);
    setDiff(null);
    setComment('');
    setLineComments([]);
    setError(null);
  }, [runId, loadRun]);

  const cur = run ? currentStage(run) : 'plan';
  useEffect(() => {
    if (!run || !follow) return;
    setStage(cur);
    setView('stage');
    setAttemptNo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, run?.status, follow]);

  const shows = (s: StageId) => view === 'stage' && stage === s;
  const showPlan = shows('plan') || shows('gate1');
  const showDiff = shows('gate2') || shows('limit');

  const refreshDocs = () => window.psflow.core.getChangeDocs(runId).then(setDocs).catch(() => setDocs(null));
  const refreshDiff = () => {
    setDiffErr(null);
    return window.psflow.core.getDiff(runId).then(setDiff).catch((e) => setDiffErr(cleanErr(e)));
  };
  useEffect(() => {
    if (showPlan) void refreshDocs();
    if (showDiff) void refreshDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlan, showDiff, runId, run?.next, run?.status]);

  // После каждой стадии план мог поменяться (агент отмечает пункты tasks.md).
  useEffect(() => onCoreEvent((e) => {
    if (e.type === 'stage.started' && e.runId === runId && showPlan) void refreshDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [runId, showPlan]);

  const select = (s: StageId) => {
    setStage(s);
    setView('stage');
    setAttemptNo(null);
    setFollow(run ? s === currentStage(run) : true);
  };

  const tries = run ? run.attempts.filter((a) => a.stage === stage && !isGate(a.stage)) : [];
  const attempt = tries.find((a) => a.attempt === attemptNo) ?? tries[tries.length - 1];
  const attemptIdx = attempt ? tries.indexOf(attempt) : -1;

  // ↑/↓ — стадии, ←/→ — попытки (когда фокус не в поле ввода).
  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable], .monaco-editor') || e.metaKey || e.ctrlKey || e.altKey) return;
      const order = STAGES.map((x) => x.id).filter((id) => run.attempts.some((a) => a.stage === id) || id === run.next);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = order.indexOf(view === 'stage' ? stage : cur);
        const next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) select(next);
        e.preventDefault();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && view === 'stage' && tries.length > 1) {
        const i = Math.min(tries.length - 1, Math.max(0, attemptIdx + (e.key === 'ArrowRight' ? 1 : -1)));
        setAttemptNo(tries[i].attempt);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!run) {
    return (
      <div className="screen">
        <div className="scroll center"><span className="spinner big" /></div>
      </div>
    );
  }

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      if (name !== 'stop') {
        setComment('');
        setLineComments([]);
      }
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };
  const dispatch = window.psflow.core.dispatch;

  const live = run.status === 'running' || run.status === 'waiting';
  const resumable = run.status === 'stopped';
  const gate = run.status === 'waiting' || (run.status === 'stopped' && (run.next === 'gate1' || run.next === 'gate2' || run.next === 'limit')) ? run.next : null;
  const lastReview = run.reviews[run.reviews.length - 1];
  const stageDef = STAGES.find((x) => x.id === stage);
  const isCurrent = stage === cur;

  // Результаты тестов и ревью копятся по порядку попыток.
  const testIdx = Math.min(run.tests.length - 1, attemptIdx < 0 ? run.tests.length - 1 : attemptIdx);
  const reviewIdx = Math.min(run.reviews.length - 1, attemptIdx < 0 ? run.reviews.length - 1 : attemptIdx);

  const slice: LogSlice | undefined = attempt && LOG_TITLE[stage]
    ? { title: LOG_TITLE[stage]!, attempt: attempt.attempt, stage, live: attempt.status === 'running' }
    : undefined;

  return (
    <div className="screen run">
      <div className={`run-grid ${showDiff ? 'is-wide' : ''}`}>
        <aside className="run-left">
          <Metrics run={run} />
          <StageRail run={run} selected={view === 'stage' ? stage : null} onSelect={select} />
        </aside>

        <section className="run-main">
          <header className="run-head">
            <div className="run-title">
              <h1 title={run.task}>{run.title}</h1>
              <div className="run-meta">
                <StatusPill status={run.status} />
                <span className="chip mono" title={run.branch}><GitBranch size={12} /> {run.branch}</span>
                <span className="muted mono path" title={run.projectPath}>{shortPath(run.projectPath)}</span>
              </div>
            </div>
            <div className="run-actions">
              <Button tone="quiet" icon={<FolderOpen size={16} />} title="Открыть worktree" onClick={() => void window.psflow.openPath(run.worktreePath)} />
              {resumable && !gate && (
                <Button tone="ghost" icon={<Play size={14} />} busy={busy === 'resume'} onClick={() => act('resume', () => dispatch({ type: 'run.resume', runId }))}>
                  Продолжить
                </Button>
              )}
              {live && (
                <Button tone="danger" icon={<CircleStop size={15} />} busy={busy === 'stop'} onClick={() => act('stop', () => dispatch({ type: 'run.stop', runId }))}>
                  Стоп
                </Button>
              )}
            </div>
          </header>

          <div className="tab-groups">
            <PillTabs<View>
              className="tabs"
              value={view === 'stage' ? null : view}
              onChange={(v) => { setView(v); setFollow(false); }}
              items={[
                { id: 'timeline', label: 'Таймлайн', disabled: !run.attempts.length },
                { id: 'log', label: 'Лог' },
              ]}
            />
            {view === 'stage' && stageDef && (
              <div className="stage-head" key={stage}>
                <span className="stage-head-icon">{STAGE_ICON[stage]}</span>
                <strong>{stageDef.title}</strong>
                {tries.length > 1 && (
                  <PillTabs<string>
                    className="tabs attempts"
                    value={attempt ? String(attempt.attempt) : null}
                    onChange={(v) => setAttemptNo(Number(v))}
                    items={tries.map((a) => ({
                      id: String(a.attempt),
                      label: `#${a.attempt}`,
                      extra: a.status === 'running' ? <span className="tab-live" /> : <i className={`attempt-dot d-${a.status}`} />,
                    }))}
                  />
                )}
              </div>
            )}
            <span className="grow" />
            {!(view === 'stage' && isCurrent) && (
              <Button tone="quiet" className="back-current" onClick={() => setFollow(true)} title="Показывать стадию, на которой сейчас прогон">
                {live ? <span className="tab-live" /> : null}
                Вернуться к текущей
              </Button>
            )}
          </div>

          {(run.status !== 'finished' || (view === 'stage' && isCurrent && !showDiff)) && <Banner run={run} />}

          <div className="tab-body">
            <div className={`pane ${view === 'log' ? '' : 'is-hidden'}`}><LiveLog runId={runId} /></div>
            {view === 'timeline' && <div className="tab-enter" key="timeline"><TimelinePanel run={run} onSelect={select} /></div>}
            {showPlan && <div className="tab-enter" key="plan"><PlanView docs={docs} run={run} /></div>}
            {view === 'stage' && slice && (
              <div className="tab-enter pane-log" key={`log-${stage}-${slice.attempt}`}><LiveLog runId={runId} slice={slice} /></div>
            )}
            {shows('tests') && !slice && <div className="tab-enter" key={`tests-${testIdx}`}><TestsView run={run} idx={testIdx} /></div>}
            {shows('review') && !slice && <div className="tab-enter" key={`review-${reviewIdx}`}><ReviewView run={run} idx={reviewIdx} /></div>}
            {view === 'stage' && !showPlan && !showDiff && !slice && !shows('tests') && !shows('review') && (
              <Empty icon={<Sparkles />} title={`${stageDef?.title ?? 'Стадия'} ещё не начиналась`}>Она запустится, когда до неё дойдёт прогон.</Empty>
            )}
            {showDiff && (
              diffErr ? <Empty icon={<CircleAlert />} title="Не удалось получить дифф">{diffErr}</Empty>
              : !diff ? <div className="center"><span className="spinner big" /></div>
              : <DiffReview files={diff} review={lastReview} comments={lineComments} onComments={setLineComments} readOnly={!(gate === 'gate2')} />
            )}
          </div>

          {gate && (
            <GateBar
              gate={gate}
              comment={comment}
              setComment={setComment}
              lineCount={lineComments.length}
              busy={busy}
              error={error}
              onApprove={() => act('approve', () => dispatch({ type: 'gate.approve', runId, comment }))}
              onReject={() => act('reject', () => dispatch({ type: 'gate.reject', runId, comment, lineComments }))}
              onCancel={() => act('cancel', () => dispatch({ type: 'gate.cancel', runId }))}
              onOpenAccept={() => select('gate2')}
              diffShown={showDiff}
            />
          )}
          {!gate && error && <div className="gatebar"><span className="actionbar-error">{error}</span></div>}
        </section>
      </div>
    </div>
  );
}

function Banner({ run }: { run: RunFile }) {
  if (run.status === 'finished') {
    return (
      <div className="banner b-mint">
        <CircleCheck size={18} />
        <div>
          <strong>Готово: изменение заархивировано и закоммичено в {run.branch}</strong>
          <p>Слейте ветку, когда будете готовы: <code>git merge {run.branch}</code></p>
        </div>
      </div>
    );
  }
  if (run.status === 'cancelled') return <div className="banner b-quiet"><X size={18} /><div><strong>Прогон отменён</strong></div></div>;
  if (run.status === 'stopped' && run.message) {
    const failed = run.attempts.some((a) => a.status === 'failed' && a.error === run.message);
    return (
      <div className={`banner ${failed ? 'b-coral' : 'b-amber'}`}>
        {failed ? <ShieldAlert size={18} /> : <Hand size={18} />}
        <div>
          <strong>{failed ? 'Стадия остановлена из-за ошибки' : 'Прогон остановлен'}</strong>
          <p>{run.message}</p>
        </div>
      </div>
    );
  }
  if (run.status === 'waiting' && run.next === 'limit') {
    return (
      <div className="banner b-amber">
        <Hand size={18} />
        <div>
          <strong>Нужно ваше решение</strong>
          <p>{run.message}</p>
        </div>
      </div>
    );
  }
  return null;
}

function Metrics({ run }: { run: RunFile }) {
  const now = useNow(run);
  const clock = activeClock(run, now);
  const runs = run.attempts.filter((a) => !isGate(a.stage)).length;
  const humanMs = run.attempts.filter((a) => isGate(a.stage)).reduce((n, a) => n + ((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt)), 0);
  const total = usageTotal(run.totals);
  const c = cost(run.totals);
  return (
    <div className="summary">
      <dl className="summary-grid">
        <div title={clock.paused > 0 ? `Без простоя ${ms(clock.paused)} после ошибок и остановок` : undefined}><dt>Время</dt><dd><Num animate={false} text={ms(clock.total)} /></dd></div>
        <div title={`вход ${run.totals.input}, выход ${run.totals.output}, кэш ${run.totals.cacheRead + run.totals.cacheWrite}`}><dt>Токены</dt><dd><Num text={total ? tokens(total) : '—'} /></dd></div>
        <div><dt>Стоимость</dt><dd><Num text={c ?? '—'} /></dd></div>
        <div><dt>Попытки</dt><dd><Num text={`${run.implAttemptsUsed}`} /><small>/ {run.implAttemptsLimit}</small></dd></div>
      </dl>
      <p className="stat-sum">
        <span>ждали вас {ms(humanMs)}</span>
        <span>запусков стадий: {runs}</span>
        {clock.paused > 0 && <span>простой {ms(clock.paused)} не учтён</span>}
      </p>
    </div>
  );
}

/** Крупное число тонким начертанием, единицы — мелко и серым: «18 мин 54 с», «93 тыс.». */
function Num({ text, animate = true }: { text: string; animate?: boolean }) {
  const parts = text.split(/(\d+(?:[.,]\d+)?|\$)/).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        /^[\d$]/.test(p)
          ? <span key={animate ? `${i}:${p}` : i} className={animate ? 'num-in' : undefined}>{p}</span>
          : <small key={i}>{p}</small>,
      )}
    </>
  );
}

function PlanView({ docs, run }: { docs: ChangeDocs | null; run: RunFile }) {
  const [specOpen, setSpecOpen] = useState<string | null>(null);
  if (!docs) return <div className="center"><span className="spinner big" /></div>;
  if (!docs.proposal && !docs.tasks) {
    return <Empty icon={<Sparkles />} title="План ещё пишется">Планировщик создаёт изменение <code>{run.changeId}</code>. Ход работы — в логе этой попытки ниже, когда она закончится, здесь появятся файлы.</Empty>;
  }
  const done = (docs.tasks.match(/- \[x\]/gi) ?? []).length;
  const all = (docs.tasks.match(/- \[[ x]\]/gi) ?? []).length;
  return (
    <div className="scroll">
      <div className="plan">
        <article className="doc bezel">
          <header className="doc-head"><span>proposal.md</span><span className="mono muted">{run.changeId}</span></header>
          <Markdown source={docs.proposal} />
        </article>
        <article className="doc bezel">
          <header className="doc-head">
            <span>tasks.md</span>
            {all > 0 && (
              <span className="progress" title={`${done} из ${all}`}>
                <i style={{ width: `${(done / all) * 100}%` }} />
                <b>{done}/{all}</b>
              </span>
            )}
          </header>
          <Markdown source={docs.tasks} className="tasks" />
        </article>
        {docs.design && (
          <article className="doc bezel"><header className="doc-head"><span>design.md</span></header><Markdown source={docs.design} /></article>
        )}
        {docs.specs.length > 0 && (
          <article className="doc bezel">
            <header className="doc-head"><span>Дельты спецификаций</span><span className="muted">{docs.specs.length}</span></header>
            {docs.specs.map((s) => (
              <div key={s.path} className="spec">
                <button className="spec-toggle" onClick={() => setSpecOpen(specOpen === s.path ? null : s.path)} aria-expanded={specOpen === s.path}>
                  <span className="mono">{s.path}</span>
                  <span className="muted">{specOpen === s.path ? 'свернуть' : 'показать'}</span>
                </button>
                {specOpen === s.path && <Markdown source={s.content} className="spec-md" />}
              </div>
            ))}
          </article>
        )}
      </div>
    </div>
  );
}

function TestsView({ run, idx }: { run: RunFile; idx: number }) {
  const t = run.tests[idx];
  if (!t) return <Empty icon={<Sparkles />} title="Тесты ещё не запускались" />;
  return (
    <div className="scroll">
      <div className="tests">
        <div className={`tests-head ${t.passed ? 'is-ok' : 'is-bad'}`}>
          <strong>{t.passed ? 'Зелёные' : 'Красные'}</strong>
          <span className="mono">{t.command || 'команда не задана'}</span>
          <span className="muted">код {t.exitCode ?? '—'} · {(t.durationMs / 1000).toFixed(1)} с{t.timedOut ? ' · таймаут' : ''}</span>
        </div>
        <pre className="output">{stripAnsi(t.output)}</pre>
      </div>
    </div>
  );
}

function ReviewView({ run, idx }: { run: RunFile; idx: number }) {
  const r = run.reviews[idx];
  const items = useMemo(() => r ? [...r.blocking.map((x) => ({ ...x, kind: 'blocking' as const })), ...r.notes.map((x) => ({ ...x, kind: 'note' as const }))] : [], [r]);
  if (!r) return <Empty icon={<Sparkles />} title="Ревью ещё не было" />;
  return (
    <div className="scroll">
      <div className="review">
        <div className={`verdict bezel ${r.blocking.length ? 'is-bad' : 'is-ok'}`}>
          <span className="verdict-mark">{r.blocking.length ? r.blocking.length : <CircleCheck size={22} />}</span>
          <div>
            <strong>{r.blocking.length ? `Блокирующих замечаний: ${r.blocking.length}` : 'Блокирующих замечаний нет'}</strong>
            <p>{r.blocking.length ? 'Задача вернулась исполнителю с этими замечаниями.' : 'Изменение передано вам на приёмку.'} Заметок: {r.notes.length}.</p>
          </div>
          <span className="muted mono">codex · {run.models.reviewer || 'по умолчанию'}</span>
        </div>
        <ul className="review-list">
          {items.map((x, i) => (
            <li key={i} className={`note n-${x.kind}`}>
              {x.file && <span className="note-loc">{x.file}{x.line ? `:${x.line}` : ''}</span>}
              <p>{x.message}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function GateBar(props: {
  gate: StageId; comment: string; setComment: (s: string) => void; lineCount: number; busy: string | null; error: string | null;
  onApprove: () => void; onReject: () => void; onCancel: () => void; onOpenAccept: () => void; diffShown: boolean;
}) {
  const { gate, comment, setComment, lineCount, busy, error } = props;
  const [open, setOpen] = useState(false);
  const title = gate === 'gate1' ? 'Утверждение плана' : gate === 'gate2' ? 'Приёмка' : 'Попытки исчерпаны';
  const needsComment = gate !== 'limit';
  return (
    <div className="gatebar is-gate">
      <div className="gate-sign" aria-hidden>{gate === 'gate2' ? <ClipboardCheck size={17} /> : <UserRoundCheck size={17} />}</div>
      <div className="gate-text">
        <strong>{title}</strong>
        <span>
          {gate === 'gate1' && 'Проверьте proposal и tasks выше.'}
          {gate === 'gate2' && (props.diffShown ? `Замечаний на строках: ${lineCount}. Они уйдут исполнителю при возврате.` : 'Посмотрите дифф и замечания ревьюера.')}
          {gate === 'limit' && 'Можно дать исполнителю ещё одну попытку с вашим комментарием.'}
        </span>
      </div>
      {(open || gate === 'limit') && (
        <TextArea
          className="gate-comment"
          rows={2}
          autoFocus={open}
          placeholder={gate === 'limit' ? 'Подсказка исполнителю (необязательно)' : 'Что доработать'}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <div className="gate-actions">
        {error && <span className="actionbar-error">{error}</span>}
        {gate === 'gate2' && !props.diffShown && <Button tone="quiet" onClick={props.onOpenAccept}>Открыть дифф</Button>}
        {gate === 'gate1' && <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>Отменить задачу</Button>}
        {gate === 'limit' ? (
          <>
            <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>Остановить</Button>
            <Button tone="primary" icon={<RotateCcw size={14} />} busy={busy === 'approve'} onClick={props.onApprove}>Ещё попытка</Button>
          </>
        ) : (
          <>
            {needsComment && !open && lineCount === 0 ? (
              <Button tone="ghost" icon={<RotateCcw size={14} />} onClick={() => setOpen(true)}>Вернуть с комментарием</Button>
            ) : (
              <Button tone="ghost" icon={<RotateCcw size={14} />} busy={busy === 'reject'} disabled={!comment.trim() && lineCount === 0} onClick={props.onReject}>
                Вернуть{lineCount ? ` (+${lineCount})` : ''}
              </Button>
            )}
            <Button tone="approve" icon={<CircleCheck size={15} />} busy={busy === 'approve'} onClick={props.onApprove}>
              {gate === 'gate1' ? 'Принять план' : 'Принять'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
