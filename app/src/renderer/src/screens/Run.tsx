import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, ChevronDown, CircleAlert, FileText, Image as ImageIcon, CircleCheck, CircleStop, ClipboardCheck, FolderOpen, GitMerge, MousePointerClick, GitBranch, Hand, Play, RotateCcw, ShieldAlert, Sparkles, UserRoundCheck, X,
} from 'lucide-react';
import type { DiffFile, LineComment, RunFile, StageId } from '@psflow/core';
import { STAGE_ICON } from '../components/StageRail';
import { PillTabs } from '../components/PillTabs';
import { Timeline, useNow } from '../components/Timeline';
import { isGate } from '../lib/bars';
import { STAGES, nodeState } from '../lib/stages';
import { activeClock, ms } from '../lib/clock';
import { LiveLog, type LogSlice } from '../components/Terminal';
import { Markdown } from '../components/Markdown';
import { DiffReview } from '../components/DiffReview';
import { Button, Empty, StatusPill, TextArea } from '../components/ui';
import { onCoreEvent, useStore } from '../lib/store';
import { cost, duration, shortPath, tokens, usageTotal, when } from '../lib/format';
import type { ChangeDocs } from '../../../shared/ipc';

type View = 'timeline' | 'log';

/** Заголовок попытки в файле лога (orchestrator STAGE_TITLES). */
const LOG_TITLE: Partial<Record<StageId, string>> = { implement: 'Реализация', finish: 'Завершение' };

/** Строка ганта, в которой сейчас прогон (или итоговая — для завершённого). */
function currentStage(run: RunFile): StageId {
  if (run.status === 'finished') return 'gate2';
  if (run.next === 'limit') return 'gate2';
  return run.next;
}

const cleanErr = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function RunScreen({ runId }: { runId: string }) {
  const { state, loadRun } = useStore();
  const run = state.details[runId];
  const [view, setView] = useState<View>('timeline');
  /** Стадия, чьи детали открыты в выезжающей панели; null — панель закрыта. */
  const [drawer, setDrawer] = useState<StageId | null>(null);
  /** Выбранная попытка стадии; null — последняя. */
  const [attemptNo, setAttemptNo] = useState<number | null>(null);
  const [docs, setDocs] = useState<ChangeDocs | null>(null);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [lineComments, setLineComments] = useState<LineComment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gateKey = useRef('');
  const [descOpen, setDescOpen] = useState(false);
  /** Идёт обратная анимация: детали гаснут, гант разворачивается — потом панель размонтируется. */
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = () => {
    if (!drawer || closing) return;
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setDrawer(null);
      setClosing(false);
    }, 520);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  useEffect(() => {
    void loadRun(runId);
    setView('timeline');
    setDrawer(null);
    setAttemptNo(null);
    setDocs(null);
    setDiff(null);
    setComment('');
    setLineComments([]);
    setError(null);
    gateKey.current = '';
  }, [runId, loadRun]);

  // Гейт ждёт решения — сами открываем детали этой стадии: план или дифф.
  useEffect(() => {
    if (!run) return;
    const key = `${run.next}:${run.status}`;
    if (key === gateKey.current) return;
    gateKey.current = key;
    if (run.status === 'waiting') {
      setView('timeline');
      setDrawer(run.next === 'limit' ? 'gate2' : run.next);
      setAttemptNo(null);
    }
  }, [run]);

  const showPlan = drawer === 'plan' || drawer === 'gate1';
  const showDiff = drawer === 'gate2';

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

  useEffect(() => onCoreEvent((e) => {
    if (e.type === 'stage.started' && e.runId === runId && showPlan) void refreshDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [runId, showPlan]);

  const open = (s: StageId) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setClosing(false);
    setView('timeline');
    setDrawer(s);
    setAttemptNo(null);
  };

  const tries = run && drawer ? run.attempts.filter((a) => a.stage === drawer && !isGate(a.stage)) : [];
  const attempt = tries.find((a) => a.attempt === attemptNo) ?? tries[tries.length - 1];
  const attemptIdx = attempt ? tries.indexOf(attempt) : -1;

  // Esc — закрыть панель; ↑/↓ — соседняя стадия; ←/→ — попытки.
  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable], .monaco-editor') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && drawer) {
        e.preventDefault();
        close();
        return;
      }
      if (!drawer) return;
      const order = STAGES.map((x) => x.id).filter((id) => run.attempts.some((a) => a.stage === id) || id === run.next);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = order.indexOf(drawer);
        const next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) open(next);
        e.preventDefault();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && tries.length > 1) {
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
  const stageDef = drawer ? STAGES.find((x) => x.id === drawer) : undefined;
  const testIdx = Math.min(run.tests.length - 1, attemptIdx < 0 ? run.tests.length - 1 : attemptIdx);
  const reviewIdx = Math.min(run.reviews.length - 1, attemptIdx < 0 ? run.reviews.length - 1 : attemptIdx);
  const slice: LogSlice | undefined = drawer && attempt && LOG_TITLE[drawer]
    ? { title: LOG_TITLE[drawer]!, attempt: attempt.attempt, stage: drawer, live: attempt.status === 'running' }
    : undefined;

  const gateBar = gate && (
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
      onOpenAccept={() => open(gate === 'gate1' ? 'gate1' : 'gate2')}
      diffShown={gate === 'gate1' ? showPlan : showDiff}
    />
  );

  return (
    <div className="screen run run-v3">
      <header className="run-head">
        <div className="run-title">
          <div className="title-row">
            <h1 className={run.titleFromPlan ? 'is-named' : 'is-draft'}>{run.title}</h1>
            <button className={`desc-toggle ${descOpen ? 'is-on' : ''}`} onClick={() => setDescOpen(!descOpen)} aria-expanded={descOpen}>
              <FileText size={14} />
              Описание
              {run.attachments?.length ? <span className="desc-count"><ImageIcon size={12} />{run.attachments.length}</span> : null}
              <ChevronDown size={14} className="desc-chev" />
            </button>
          </div>
          {!run.titleFromPlan && run.status === 'running' && <span className="title-hint">Название придумает планировщик</span>}
          <div className={`desc ${descOpen ? 'is-open' : ''}`}>
            <div className="desc-inner">
              <p className="desc-text">{run.task}</p>
              {run.attachments?.length ? <Attachments runId={runId} count={run.attachments.length} /> : null}
            </div>
          </div>
          <div className="run-meta">
            <StatusPill status={run.status} />
            <span className="chip mono" title={run.branch}><GitBranch size={12} /> {run.branch}</span>
            {run.status === 'finished' && <MergeControl run={run} runId={runId} />}
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

      <Metrics run={run} />

      <section className="run-main">
        <div className="tab-groups">
          <PillTabs<View>
            className="tabs"
            value={view}
            onChange={(v) => { setView(v); if (v === 'log') { setDrawer(null); setClosing(false); } }}
            items={[
              { id: 'timeline', label: 'Таймлайн' },
              { id: 'log', label: 'Лог' },
            ]}
          />
          <span className="grow" />
          {view === 'timeline' && !drawer && (
            <span className="tab-hint"><MousePointerClick size={14} /> Нажмите на стадию — откроются её детали</span>
          )}
        </div>

        <Banner run={run} runId={runId} />

        <div className="tab-body">
          <div className={`pane ${view === 'log' ? '' : 'is-hidden'}`}><LiveLog runId={runId} /></div>
          {view === 'timeline' && (
            <div className={`split ${drawer && !closing ? 'is-open' : ''} ${showDiff && !closing ? 'is-wide' : ''}`}>
              <div className="split-left scroll">
                <div className="timeline-panel">
                  <Timeline run={run} selected={drawer} current={live ? currentStage(run) : null} onSelect={open} compact={Boolean(drawer) && !closing} />
                </div>
              </div>
              <div className="split-right">
                {drawer && stageDef && (
                  <div className={`details ${closing ? 'is-closing' : ''}`} key={drawer}>
                    <header className="drawer-head">
                      <span className={`drawer-icon st-${nodeState(run, drawer)}`}>{STAGE_ICON[drawer]}</span>
                      <div className="drawer-title">
                        <strong>{stageDef.title}</strong>
                        <span>{stageDef.actor}{stageDef.role && run.models[stageDef.role] ? ` · ${run.models[stageDef.role]}` : ''}{attempt?.summary ? ` — ${attempt.summary}` : ''}</span>
                      </div>
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
                      <Button tone="quiet" icon={<X size={18} />} title="Свернуть детали (Esc)" onClick={close} />
                    </header>
                    <div className="drawer-body">
                      {showPlan && <PlanView docs={docs} run={run} />}
                      {slice && <div className="pane-log"><LiveLog key={`${drawer}-${slice.attempt}`} runId={runId} slice={slice} /></div>}
                      {drawer === 'tests' && <TestsView run={run} idx={testIdx} />}
                      {drawer === 'review' && <ReviewView run={run} idx={reviewIdx} />}
                      {showDiff && (
                        diffErr ? <Empty icon={<CircleAlert />} title="Не удалось получить дифф">{diffErr}</Empty>
                        : !diff ? <div className="center"><span className="spinner big" /></div>
                        : <DiffReview files={diff} review={lastReview} comments={lineComments} onComments={setLineComments} readOnly={!(gate === 'gate2')} />
                      )}
                      {!showPlan && !slice && !showDiff && drawer !== 'tests' && drawer !== 'review' && (
                        <Empty icon={<Sparkles />} title={`${stageDef.title} ещё не начиналась`}>Стадия запустится, когда до неё дойдёт прогон.</Empty>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {gateBar}
        {!gate && error && <div className="gatebar"><span className="actionbar-error">{error}</span></div>}
      </section>
    </div>
  );
}

function Banner({ run, runId }: { run: RunFile; runId: string }) {
  if (run.status === 'finished') return null;
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

/** Готовый прогон: влить ветку psflow/<id> в выбранную ветку — прямо в строке статуса. */
function MergeControl({ run, runId }: { run: RunFile; runId: string }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (run.merged) return;
    void window.psflow.core.listBranches(runId).then((b) => {
      setBranches(b.branches);
      setTarget((t) => t || b.current || b.branches[0] || '');
    }).catch((e) => setError(cleanErr(e)));
  }, [runId, run.merged]);

  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.psflow.core.dispatch({ type: 'run.merge', runId, target });
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  if (run.merged) {
    return (
      <span className="chip merged" title={`Коммит слияния ${run.merged.commit} · ${when(run.merged.at)}`}>
        <GitMerge size={12} /> влито в {run.merged.into} · <span className="mono">{run.merged.commit.slice(0, 7)}</span>
      </span>
    );
  }
  return (
    <span className="merge-inline">
      <ArrowRight size={14} className="muted" />
      <label className="select" title="Ветка, в которую влить результат">
        <span>в</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy || !branches.length}>
          {!branches.length && <option value="">ветки не найдены</option>}
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <ChevronDown size={13} />
      </label>
      <Button tone="approve" className="merge-btn" icon={<GitMerge size={14} />} busy={busy} disabled={!target} onClick={() => void merge()}>
        Влить
      </Button>
      {error && <span className="merge-error" title={error}>{error}</span>}
    </span>
  );
}

/** Миниатюры изображений задачи; клик — открыть крупно. */
function Attachments({ runId, count }: { runId: string; count: number }) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all(Array.from({ length: count }, (_, i) => window.psflow.core.getAttachment(runId, i))).then((u) => alive && setUrls(u));
    return () => { alive = false; };
  }, [runId, count]);
  return (
    <>
      <div className="desc-images">
        {urls.map((u, i) => u && (
          <button key={i} className="imgdrop-thumb" onClick={() => setBig(u)} title="Открыть"><img src={u} alt={`Изображение ${i + 1}`} /></button>
        ))}
      </div>
      {big && (
        <div className="lightbox" onClick={() => setBig(null)} role="dialog" aria-label="Изображение">
          <img src={big} alt="" />
        </div>
      )}
    </>
  );
}

function Metrics({ run }: { run: RunFile }) {
  const now = useNow(run);
  const clock = activeClock(run, now);
  const runs = run.attempts.filter((a) => !isGate(a.stage)).length;
  const humanMs = run.attempts.filter((a) => isGate(a.stage)).reduce((n, a) => n + ((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt)), 0);
  const total = usageTotal(run.totals);
  const c = cost(run.totals);
  return (
    <dl className="metrics-row">
      <div className="stat" title={clock.paused > 0 ? `Без простоя ${ms(clock.paused)} после ошибок и остановок` : undefined}>
        <dt>Активное время</dt><dd><Num animate={false} text={ms(clock.total)} /></dd>
        {clock.paused > 0 && <span className="stat-note">простой {ms(clock.paused)} не учтён</span>}
      </div>
      <div className="stat"><dt>Ждали вас</dt><dd><Num animate={false} text={ms(humanMs)} /></dd></div>
      <div className="stat"><dt>Запусков стадий</dt><dd><Num text={String(runs)} /></dd></div>
      <div className="stat" title={`вход ${run.totals.input}, выход ${run.totals.output}, кэш ${run.totals.cacheRead + run.totals.cacheWrite}`}><dt>Токены</dt><dd><Num text={total ? tokens(total) : '—'} /></dd></div>
      <div className="stat"><dt>Стоимость</dt><dd><Num text={c ?? '—'} /></dd></div>
      <div className="stat"><dt>Попытки реализации</dt><dd><Num text={`${run.implAttemptsUsed}`} /><small>/ {run.implAttemptsLimit}</small></dd></div>
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
          {gate === 'gate1' && (props.diffShown ? 'Проверьте proposal и tasks выше.' : 'Откройте план и проверьте proposal и tasks.')}
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
        {!props.diffShown && gate !== 'limit' && <Button tone="quiet" onClick={props.onOpenAccept}>{gate === 'gate1' ? 'Открыть план' : 'Открыть дифф'}</Button>}
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
