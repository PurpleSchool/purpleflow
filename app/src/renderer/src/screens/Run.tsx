import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert, CircleCheck, CircleStop, ClipboardCheck, Maximize2, FolderOpen, GitBranch, Hand, Play, RotateCcw, ShieldAlert, Sparkles, UserRoundCheck, X,
} from 'lucide-react';
import type { DiffFile, LineComment, RunFile, StageId } from '@psflow/core';
import { StageRail } from '../components/StageRail';
import { PillTabs } from '../components/PillTabs';
import { Timeline, TimelinePanel } from '../components/Timeline';
import { activeClock, ms } from '../lib/clock';
import { LiveLog } from '../components/Terminal';
import { Markdown } from '../components/Markdown';
import { DiffReview } from '../components/DiffReview';
import { Button, Empty, StatusPill, TextArea } from '../components/ui';
import { onCoreEvent, useStore } from '../lib/store';
import { cost, duration, shortPath, tokens, usageTotal } from '../lib/format';
import type { ChangeDocs } from '../../../shared/ipc';

type Tab = 'timeline' | 'log' | 'plan' | 'tests' | 'review' | 'accept';

const TAB_FOR: Record<StageId, Tab> = {
  plan: 'plan', gate1: 'plan', implement: 'log', tests: 'tests', review: 'review', gate2: 'accept', limit: 'log', finish: 'accept',
};

const cleanErr = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function RunScreen({ runId }: { runId: string }) {
  const { state, loadRun } = useStore();
  const run = state.details[runId];
  const [tab, setTab] = useState<Tab>('log');
  const [selected, setSelected] = useState<StageId | null>(null);
  const [docs, setDocs] = useState<ChangeDocs | null>(null);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [lineComments, setLineComments] = useState<LineComment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastNext = useRef<string>('');

  useEffect(() => {
    void loadRun(runId);
    setTab('log');
    setSelected(null);
    setDocs(null);
    setDiff(null);
    setComment('');
    setLineComments([]);
    setError(null);
    lastNext.current = '';
  }, [runId, loadRun]);

  // Вкладка следует за прогоном: гейт 1 → план, гейт 2 → приёмка.
  useEffect(() => {
    if (!run) return;
    const key = `${run.next}:${run.status}`;
    if (key === lastNext.current) return;
    lastNext.current = key;
    if (run.status === 'waiting' && run.next === 'gate1') setTab('plan');
    else if (run.status === 'waiting' && run.next === 'gate2') setTab('accept');
    else if (run.status === 'finished') setTab('accept');
    else if (run.status === 'running') setTab('log');
    setSelected(null);
  }, [run]);

  const refreshDocs = () => window.psflow.core.getChangeDocs(runId).then(setDocs).catch(() => setDocs(null));
  const refreshDiff = () => {
    setDiffErr(null);
    return window.psflow.core.getDiff(runId).then(setDiff).catch((e) => setDiffErr(cleanErr(e)));
  };

  useEffect(() => {
    if (tab === 'plan' || tab === 'review') void refreshDocs();
    if (tab === 'accept') void refreshDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, runId, run?.next, run?.status]);

  // После каждой стадии план мог поменяться (агент отмечает пункты tasks.md).
  useEffect(() => onCoreEvent((e) => {
    if (e.type === 'stage.started' && e.runId === runId && tab === 'plan') void refreshDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [runId, tab]);

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
  const lastTest = run.tests[run.tests.length - 1];
  const hasCode = run.attempts.some((a) => a.stage === 'implement');
  // План «прошёл», когда последняя попытка планировщика прошла openspec validate.
  const lastPlan = [...run.attempts].reverse().find((a) => a.stage === 'plan');
  const planState = lastPlan?.status === 'done' ? 'ok' : lastPlan?.status === 'failed' ? 'fail' : undefined;
  // Какая вкладка соответствует стадии, которая идёт или ждёт решения прямо сейчас.
  const activeTab: Tab | null = live
    ? ({ plan: 'plan', gate1: 'plan', tests: 'tests', review: 'review', gate2: 'accept', limit: 'accept' } as Partial<Record<StageId, Tab>>)[run.next] ?? null
    : null;

  const select = (s: StageId) => {
    setSelected(s);
    setTab(TAB_FOR[s]);
  };

  const tabs: { id: Tab; label: string; badge?: string; tone?: string; disabled?: boolean }[] = [
    { id: 'log', label: 'Лог' },
    { id: 'plan', label: 'План', badge: planState, tone: planState === 'ok' ? 'mint' : planState === 'fail' ? 'coral' : undefined, disabled: !run.attempts.some((a) => a.stage === 'plan') },
    { id: 'tests', label: 'Тесты', badge: lastTest ? (lastTest.passed ? 'ok' : 'fail') : undefined, tone: lastTest ? (lastTest.passed ? 'mint' : 'coral') : undefined, disabled: !run.tests.length },
    { id: 'review', label: 'Ревью', badge: lastReview ? String(lastReview.blocking.length + lastReview.notes.length) : undefined, tone: lastReview?.blocking.length ? 'coral' : 'quiet', disabled: !run.reviews.length },
    { id: 'accept', label: run.status === 'finished' ? 'Дифф' : 'Приёмка', disabled: !hasCode },
  ];

  return (
    <div className="screen run">
      <div className={`run-grid ${tab === 'accept' ? 'is-wide' : ''}`}>
        <aside className="run-left">
          <Metrics run={run} onOpenTimeline={() => setTab('timeline')} />
          <StageRail run={run} selected={selected} onSelect={select} />
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
            <PillTabs<Tab>
              className="tabs"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'timeline', label: 'Таймлайн', disabled: !run.attempts.length },
                { id: 'log', label: 'Лог' },
              ]}
            />
            <PillTabs<Tab>
              className="tabs"
              value={tab}
              onChange={setTab}
              items={tabs.filter((t) => t.id !== 'log').map((t) => ({
                id: t.id,
                label: t.label,
                disabled: t.disabled,
                extra: activeTab === t.id
                ? <span className="tab-live" title="Идёт сейчас" />
                : t.badge ? <span className={`tab-badge b-${t.tone}`}>{t.badge === 'ok' ? '✓' : t.badge === 'fail' ? '✗' : t.badge}</span> : undefined,
              }))}
            />
          </div>

          {!(tab === 'accept' && run.status === 'finished') && <Banner run={run} />}

          <div className="tab-body">
            <div className={`pane ${tab === 'log' ? '' : 'is-hidden'}`}><LiveLog runId={runId} /></div>
            {tab === 'timeline' && <div className="tab-enter" key="timeline"><TimelinePanel run={run} /></div>}
            {tab === 'plan' && <div className="tab-enter" key="plan"><PlanView docs={docs} run={run} /></div>}
            {tab === 'tests' && <div className="tab-enter" key="tests"><TestsView run={run} /></div>}
            {tab === 'review' && <div className="tab-enter" key="review"><ReviewView run={run} /></div>}
            {tab === 'accept' && (
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
              onOpenAccept={() => setTab('accept')}
              tab={tab}
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

function Metrics({ run, onOpenTimeline }: { run: RunFile; onOpenTimeline: () => void }) {
  const live = run.status === 'running' || run.status === 'waiting';
  const clock = activeClock(run);
  const isGate = (st: StageId) => st === 'gate1' || st === 'gate2' || st === 'limit';
  const runs = run.attempts.filter((a) => !isGate(a.stage)).length;
  const humanMs = run.attempts.filter((a) => isGate(a.stage)).reduce((n, a) => n + ((a.endedAt ? Date.parse(a.endedAt) : Date.now()) - Date.parse(a.startedAt)), 0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const total = usageTotal(run.totals);
  const c = cost(run.totals);
  return (
    <dl className="metrics">
      <div className="stat stat-wide">
        <button className="stat-expand" onClick={onOpenTimeline} title="Открыть таймлайн">
          <Maximize2 size={14} />
        </button>
        <dt>Время</dt>
        <dd title={clock.paused > 0 ? `Без простоя ${ms(clock.paused)} после ошибок и остановок` : undefined}><Num animate={false} text={ms(clock.total)} /></dd>
        <p className="stat-sum">
          <span>ждали вас {ms(humanMs)}</span>
          <span>запусков стадий: {runs}</span>
          {clock.paused > 0 && <span>простой {ms(clock.paused)} не учтён</span>}
        </p>
        <button className="gantt-open" onClick={onOpenTimeline} aria-label="Открыть таймлайн">
          <Timeline run={run} />
        </button>
      </div>
      <div className="stat"><dt>Токены</dt><dd title={`вход ${run.totals.input}, выход ${run.totals.output}, кэш ${run.totals.cacheRead + run.totals.cacheWrite}`}><Num text={total ? tokens(total) : '—'} /></dd></div>
      <div className="stat"><dt>Стоимость</dt><dd><Num text={c ?? '—'} /></dd></div>
      <div className="stat"><dt>Попытки</dt><dd><Num text={`${run.implAttemptsUsed}`} /><small>/ {run.implAttemptsLimit}</small></dd></div>
    </dl>
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
    return <Empty icon={<Sparkles />} title="План ещё пишется">Планировщик создаёт изменение <code>{run.changeId}</code>. Ход работы — во вкладке «Лог».</Empty>;
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

function TestsView({ run }: { run: RunFile }) {
  const [idx, setIdx] = useState(run.tests.length - 1);
  useEffect(() => setIdx(run.tests.length - 1), [run.tests.length]);
  const t = run.tests[idx];
  if (!t) return <Empty icon={<Sparkles />} title="Тесты ещё не запускались" />;
  return (
    <div className="scroll">
      <div className="tests">
        <div className="tests-runs">
          {run.tests.map((x, i) => (
            <button key={i} className={`trun ${x.passed ? 'is-ok' : 'is-bad'} ${i === idx ? 'is-on' : ''}`} onClick={() => setIdx(i)}>
              <span>{x.passed ? '✓' : '✗'}</span> Попытка {i + 1}
            </button>
          ))}
        </div>
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

function ReviewView({ run }: { run: RunFile }) {
  const [idx, setIdx] = useState(run.reviews.length - 1);
  useEffect(() => setIdx(run.reviews.length - 1), [run.reviews.length]);
  const r = run.reviews[idx];
  const items = useMemo(() => r ? [...r.blocking.map((x) => ({ ...x, kind: 'blocking' as const })), ...r.notes.map((x) => ({ ...x, kind: 'note' as const }))] : [], [r]);
  if (!r) return <Empty icon={<Sparkles />} title="Ревью ещё не было" />;
  return (
    <div className="scroll">
      <div className="review">
        <div className="tests-runs">
          {run.reviews.map((x, i) => (
            <button key={i} className={`trun ${x.blocking.length ? 'is-bad' : 'is-ok'} ${i === idx ? 'is-on' : ''}`} onClick={() => setIdx(i)}>
              <span>{x.blocking.length ? '✗' : '✓'}</span> Ревью {i + 1}
            </button>
          ))}
        </div>
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
  onApprove: () => void; onReject: () => void; onCancel: () => void; onOpenAccept: () => void; tab: Tab;
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
          {gate === 'gate1' && 'Проверьте proposal и tasks слева во вкладке «План».'}
          {gate === 'gate2' && (props.tab === 'accept' ? `Замечаний на строках: ${lineCount}. Они уйдут исполнителю при возврате.` : 'Посмотрите дифф и замечания ревьюера.')}
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
        {gate === 'gate2' && props.tab !== 'accept' && <Button tone="quiet" onClick={props.onOpenAccept}>Открыть дифф</Button>}
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
