import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Clock3, MessageCircleQuestion, GitPullRequest, Globe, Trash2, Wrench,
  ArrowRight, ChevronDown, CircleAlert, FileText, Image as ImageIcon, CircleCheck, CircleStop, ClipboardCheck, FolderOpen, GitMerge, MousePointerClick, GitBranch, Hand, Play, RotateCcw, ShieldAlert, Sparkles, UserRoundCheck, X,
} from 'lucide-react';
import type { DiffFile, LineComment, PrStatus, RunFile, StageAttempt, StageId } from '@psflow/core';
import { STAGE_ICON } from '../components/StageRail';
import { PillTabs } from '../components/PillTabs';
import { Timeline, useNow } from '../components/Timeline';
import { isGate } from '../lib/bars';
import { MODES, nodeState, runStages, type Mode } from '../lib/stages';
import { MODE_ICON } from '../components/ModeIcon';
import { activeClock, ms } from '../lib/clock';
import { LiveLog, cut, finalMessage, type LogSlice } from '../components/Terminal';
import { Markdown } from '../components/Markdown';
import { AgentScreen, BrowserPane, useAgentScreen, usePreview } from '../components/BrowserPane';
import { DiffReview } from '../components/DiffReview';
import { Button, Empty, Input, StatusPill, TextArea } from '../components/ui';
import { onCoreEvent, useStore } from '../lib/store';
import { duration, shortPath, tokens, usageTotal, when } from '../lib/format';
import type { ChangeDocs } from '../../../shared/ipc';

type View = 'timeline' | 'log' | 'browser';

/** Заголовок попытки в файле лога (orchestrator STAGE_TITLES). */
const LOG_TITLE: Partial<Record<StageId, string>> = { implement: 'Реализация', finish: 'Завершение', clarify: 'Уточнение' };

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
  const preview = usePreview(runId);
  const agentScreen = useAgentScreen(runId);
  /** Команды проекта: у прогонов до вкладки «Браузер» команда запуска не сохранена в run.json. */
  const [projectRun, setProjectRun] = useState(false);
  const projectPath = run?.projectPath;
  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    void window.psflow.core.getProjectConfig(projectPath).then((c) => alive && setProjectRun(Boolean(c?.runCommand && c.appUrl))).catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectPath]);
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
      setDrawer(run.next === 'limit' ? 'gate2' : run.next === 'gate0' ? 'clarify' : run.next);
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
      const order = runStages(run).map((x) => x.id).filter((id) => run.attempts.some((a) => a.stage === id) || id === run.next);
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
      // Решение на гейте принято — детали (план, дифф) сворачиваются, снова виден весь таймлайн.
      if (['approve', 'reject', 'cancel', 'accept', 'fix', 'skip'].includes(name)) {
        setView('timeline');
        close();
      }
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };
  const dispatch = window.psflow.core.dispatch;
  const agentLive = Boolean(agentScreen.frame) || (run.status === 'running' && run.next === 'visual');
  const canRunApp = projectRun || Boolean(run.runCommand && run.appUrl) || preview.state.status !== 'idle';
  const openApp = () => {
    setView('browser');
    setDrawer(null);
    if (preview.state.status === 'idle' || preview.state.status === 'failed') void preview.start();
  };

  const live = run.status === 'running' || run.status === 'waiting';
  const resumable = run.status === 'stopped';
  const gate = run.status === 'waiting' || (run.status === 'stopped' && (run.next === 'gate1' || run.next === 'gate2' || run.next === 'limit')) ? run.next : null;
  const lastReview = run.reviews[run.reviews.length - 1];
  const stageDef = drawer ? runStages(run).find((x) => x.id === drawer) : undefined;
  const testIdx = Math.min(run.tests.length - 1, attemptIdx < 0 ? run.tests.length - 1 : attemptIdx);
  const reviewIdx = Math.min(run.reviews.length - 1, attemptIdx < 0 ? run.reviews.length - 1 : attemptIdx);
  const clarifyQuestions = drawer === 'clarify' && run.clarify?.questions.length ? run.clarify : null;
  const slice: LogSlice | undefined = drawer && attempt && LOG_TITLE[drawer] && !clarifyQuestions
    ? { title: LOG_TITLE[drawer]!, attempt: attempt.attempt, stage: drawer, live: attempt.status === 'running' }
    : undefined;

  const gateBar = gate === 'gate0' ? (
    <div className="gatebar is-gate">
      <div className="gate-sign" aria-hidden><MessageCircleQuestion size={17} /></div>
      <div className="gate-text">
        <strong>Вопросы перед планом</strong>
        <span>Ответьте выше — ответы получат все стадии. Можно продолжить и без них: планировщик решит сам.</span>
      </div>
      <div className="gate-actions">
        {error && <span className="actionbar-error">{error}</span>}
        <Button tone="quiet" busy={busy === 'cancel'} onClick={() => act('cancel', () => dispatch({ type: 'gate.cancel', runId }))}>Отменить задачу</Button>
        <Button tone="ghost" busy={busy === 'skip'} onClick={() => act('skip', () => dispatch({ type: 'gate.answer', runId, answers: [] }))}>Продолжить без ответов</Button>
      </div>
    </div>
  ) : gate && (
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
      onAccept={gate === 'limit' ? () => act('accept', () => dispatch({ type: 'gate.accept', runId })) : undefined}
      onFix={gate === 'gate2' ? () => act('fix', () => dispatch({ type: 'gate.fix', runId, comment, lineComments })) : undefined}
      onOpenAccept={() => open(gate === 'gate1' ? 'gate1' : 'gate2')}
      onOpenApp={gate === 'gate2' && canRunApp && view !== 'browser' ? openApp : undefined}
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
            <span className="chip mode-chip">{MODE_ICON[(run.mode ?? 'task') as Mode]} {MODES.find((m) => m.id === (run.mode ?? 'task'))?.title}{run.mode === 'epic' && run.phases ? ` · этап ${Math.min(run.phase ?? 1, run.phases)}/${run.phases}` : ''}</span>
            <span className="chip mono" title={run.branch}><GitBranch size={12} /> {run.branch}</span>
            {run.status === 'finished' && <MergeControl run={run} runId={runId} />}
            <span className="muted mono path" title={run.projectPath}>{shortPath(run.projectPath)}</span>
          </div>
        </div>
        <div className="run-actions">
          <Button tone="quiet" icon={<FolderOpen size={16} />} title={run.workspace === 'branch' ? 'Открыть папку проекта' : 'Открыть worktree'} onClick={() => void window.psflow.openPath(run.worktreePath)} />
          <DeleteRun run={run} runId={runId} />
          {(resumable || run.status === 'queued') && !gate && (
            <Button tone="ghost" icon={<Play size={14} />} busy={busy === 'resume'} onClick={() => act('resume', () => dispatch({ type: 'run.resume', runId }))}>
              {run.status === 'queued' || run.workspacePending ? 'Запустить сейчас' : 'Продолжить'}
            </Button>
          )}
          {(live || run.status === 'queued') && (
            <Button tone="danger" icon={<CircleStop size={15} />} busy={busy === 'stop'} onClick={() => act('stop', () => dispatch({ type: 'run.stop', runId }))}>
              {run.status === 'queued' ? 'Снять с очереди' : 'Стоп'}
            </Button>
          )}
        </div>
      </header>

      <div className="run-body">
      <Metrics run={run} />

      <section className="run-main">
        <div className="tab-groups">
          <PillTabs<View>
            className="tabs"
            value={view}
            onChange={(v) => { setView(v); if (v !== 'timeline') { setDrawer(null); setClosing(false); } }}
            items={[
              { id: 'timeline', label: 'Таймлайн' },
              { id: 'log', label: 'Лог' },
              {
                id: 'browser',
                label: 'Браузер',
                extra: agentScreen.frame ? <span className="tab-dot is-live" title="Агент работает в браузере" /> : preview.state.status === 'ready' ? <span className="tab-dot is-ok" /> : preview.state.status === 'starting' ? <span className="tab-live" /> : undefined,
              },
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
          {/* Браузер не размонтируем при переключении вкладок — страница и её состояние сохраняются. */}
          {/* Пока идёт визуальная проверка — экран браузера агента; потом — своё приложение для ручной проверки. */}
          {view === 'browser' && agentLive && <div className="pane pane-browser"><AgentScreen screen={agentScreen} /></div>}
          {(view === 'browser' || preview.state.status === 'ready') && (
            <div className={`pane pane-browser ${view === 'browser' && !agentLive ? '' : 'is-hidden'}`}><BrowserPane preview={preview} canRun={canRunApp} /></div>
          )}
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
                        <span>{drawer === 'visual' ? 'claude' : stageDef.role ? run.agents?.[stageDef.role] ?? stageDef.actor : stageDef.actor}{drawer === 'visual' ? (attempt?.model && attempt.model !== 'claude' ? ` · ${attempt.model}` : '') : stageDef.role && run.models[stageDef.role] ? ` · ${run.models[stageDef.role]}` : ''}{attempt?.summary ? ` — ${attempt.summary}` : ''}</span>
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
                      {showPlan && run.mode === 'bug' && run.repro && <ReproView run={run} kind="bug" />}
                      {showPlan && <PlanView docs={docs} run={run} />}
                      {slice && attempt && <AgentOutput key={`${drawer}-${slice.attempt}`} runId={runId} slice={slice} attempt={attempt} />}
                      {drawer === 'tests' && <TestsView run={run} idx={testIdx} />}
                      {drawer === 'review' && <ReviewView run={run} idx={reviewIdx} />}
                      {drawer === 'visual' && <VisualView key={`visual-${attempt?.attempt ?? 0}`} run={run} runId={runId} attempt={attempt} idx={Math.min((run.visuals?.length ?? 1) - 1, attemptIdx < 0 ? (run.visuals?.length ?? 1) - 1 : attemptIdx)} />}
                      {drawer === 'baseline' && <ReproView run={run} kind="baseline" />}
                      {clarifyQuestions && <ClarifyView run={run} runId={runId} waiting={run.next === 'gate0' && (run.status === 'waiting' || run.status === 'stopped')} onDone={close} />}
                      {showDiff && (
                        diffErr ? <Empty icon={<CircleAlert />} title="Не удалось получить дифф">{diffErr}</Empty>
                        : !diff ? <div className="center"><span className="spinner big" /></div>
                        : <DiffReview files={diff} review={lastReview} comments={lineComments} onComments={setLineComments} readOnly={!(gate === 'gate2')} />
                      )}
                      {!showPlan && !slice && !showDiff && drawer !== 'tests' && drawer !== 'review' && drawer !== 'visual' && drawer !== 'baseline' && !clarifyQuestions && (
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
    </div>
  );
}

/** Удаление прогона с подтверждением: worktree и данные приложения, ветка — по выбору. */
function DeleteRun({ run, runId }: { run: RunFile; runId: string }) {
  const [open, setOpen] = useState(false);
  const [withBranch, setWithBranch] = useState(Boolean(run.merged) || run.status === 'cancelled');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.psflow.core.dispatch({ type: 'run.delete', runId, deleteBranch: withBranch });
    } catch (e) {
      setError(cleanErr(e));
      setBusy(false);
    }
  };
  return (
    <div className="delete-run">
      <Button tone="quiet" icon={<Trash2 size={16} />} title="Удалить прогон" onClick={() => setOpen(!open)} />
      {open && (
        <>
          <div className="pop-backdrop" onClick={() => !busy && setOpen(false)} />
          <div className="pop delete-pop" role="dialog" aria-label="Удалить прогон">
            <strong>Удалить прогон?</strong>
            <p>
              {run.status === 'running' ? 'Прогон ещё идёт — он будет остановлен. ' : run.status === 'waiting' ? 'Прогон ждёт вашего решения — он будет закрыт без него. ' : ''}
              {run.workspace === 'branch' ? 'Удалятся лог, скриншоты и запись в истории. Файлы проекта не трогаем.' : 'Удалятся рабочая копия прогона (worktree), лог, скриншоты и запись в истории. Ваш проект не изменится.'}
            </p>
            <label className="check">
              <input type="checkbox" checked={withBranch} onChange={(e) => setWithBranch(e.target.checked)} />
              <span>Удалить и ветку <code>{run.branch}</code>{run.merged ? ' (уже влита)' : run.commit ? ' — в ней коммит с результатом' : ''}</span>
            </label>
            {error && <p className="pop-error">{error}</p>}
            <div className="pop-actions">
              <Button tone="quiet" disabled={busy} onClick={() => setOpen(false)}>Отмена</Button>
              <Button tone="danger" icon={<Trash2 size={14} />} busy={busy} onClick={() => void remove()}>Удалить</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Вопросы планировщика до плана: варианты ответа кнопками или свой текст. */
function ClarifyView({ run, runId, waiting, onDone }: { run: RunFile; runId: string; waiting: boolean; onDone: () => void }) {
  const qs = run.clarify?.questions ?? [];
  const given = run.clarify?.answers ?? [];
  const [answers, setAnswers] = useState<string[]>(() => qs.map((q) => given.find((a) => a.q === q.q)?.a ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.psflow.core.dispatch({ type: 'gate.answer', runId, answers: qs.map((q, i) => ({ q: q.q, a: answers[i] ?? '' })) });
      onDone();
    } catch (e) {
      setError(cleanErr(e));
      setBusy(false);
    }
  };
  const filled = answers.filter((a) => a.trim()).length;
  return (
    <div className="scroll">
      <div className="clarify">
        {!waiting && (
          <p className="muted">{run.clarify?.skipped ? 'Продолжили без ответов — планировщик решал сам.' : given.length ? `Ответы отправлены: ${given.length} из ${qs.length}.` : 'На вопросы не ответили.'}</p>
        )}
        {qs.map((q, i) => (
          <section key={i} className="clarify-q">
            <strong><span className="clarify-n">{i + 1}</span>{q.q}</strong>
            {q.why && <p className="muted">{q.why}</p>}
            {q.options?.length ? (
              <div className="clarify-options">
                {q.options.map((o) => (
                  <button key={o} className={`clarify-opt ${answers[i] === o ? 'is-on' : ''}`} disabled={!waiting} onClick={() => setAnswers(answers.map((a, j) => (j === i ? (a === o ? '' : o) : a)))}>
                    <i aria-hidden />
                    <span>{o}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <Input
              placeholder={q.options?.length ? 'или свой ответ' : 'Ваш ответ'}
              value={q.options?.includes(answers[i]) ? '' : answers[i]}
              disabled={!waiting}
              onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && filled) void send(); }}
            />
          </section>
        ))}
        {waiting && (
          <div className="clarify-actions">
            {error && <span className="actionbar-error">{error}</span>}
            <span className="muted">Пустые вопросы планировщик решит сам</span>
            <Button tone="primary" busy={busy} disabled={!filled} onClick={() => void send()}>Ответить и продолжить</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Banner({ run, runId }: { run: RunFile; runId: string }) {
  if (run.status === 'finished') return null;
  if (run.status === 'queued') {
    return (
      <div className="banner b-quiet">
        <Clock3 size={18} />
        <div>
          <strong>В очереди</strong>
          <p>Начнётся сам, когда освободится место — лимит одновременных прогонов задаётся в «Настройки → Модели». «Запустить сейчас» — без очереди.</p>
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

/** Готовый прогон: влить ветку psflow/<id> в выбранную ветку — прямо в строке статуса. */
function MergeControl({ run, runId }: { run: RunFile; runId: string }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState<'merge' | 'pr' | 'prMerge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prWhy, setPrWhy] = useState<string | null | undefined>(undefined);
  const [pr, setPr] = useState<PrStatus | null>(null);

  useEffect(() => {
    if (run.merged || run.pr) return;
    void window.psflow.core.listBranches(runId).then((b) => {
      setBranches(b.branches);
      setTarget((t) => t || b.current || b.branches[0] || '');
    }).catch((e) => setError(cleanErr(e)));
    void window.psflow.core.prReady(runId).then(setPrWhy).catch(() => setPrWhy('Не удалось проверить GitHub CLI'));
  }, [runId, run.merged, run.pr]);

  // Открытый PR: статус проверок CI — сразу и раз в 30 секунд, пока окно на экране.
  useEffect(() => {
    if (!run.pr) return;
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      void window.psflow.core.getPrStatus(runId).then((x) => alive && setPr(x)).catch((e) => alive && setError(cleanErr(e)));
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId, run.pr?.url]);

  const act = async (kind: 'merge' | 'pr' | 'prMerge') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'merge') await window.psflow.core.dispatch({ type: 'run.merge', runId, target });
      else if (kind === 'pr') await window.psflow.core.dispatch({ type: 'run.pr', runId, base: target });
      else {
        await window.psflow.core.dispatch({ type: 'run.prMerge', runId });
        setPr(await window.psflow.core.getPrStatus(runId));
      }
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };

  if (run.pr) {
    const c = pr?.checks;
    const ciState = !pr ? 'loading' : !c?.total ? 'none' : c.failed ? 'failed' : c.pending ? 'pending' : 'ok';
    const ciText = !pr ? '…' : !c?.total ? 'без проверок CI' : c.failed ? `проверки: ${c.failed} упало` : c.pending ? `проверки идут ${c.passed}/${c.total}` : `проверки ✓ ${c.passed}/${c.total}`;
    const merged = pr?.state === 'MERGED' || Boolean(run.merged);
    return (
      <span className="merge-inline">
        <a className={`chip pr-chip ci-${ciState}`} href={run.pr.url} target="_blank" rel="noreferrer" title="Открыть PR на GitHub">
          <GitPullRequest size={12} /> PR #{run.pr.number} → {run.pr.base}
          {!merged && <span className="pr-ci">· {ciText}</span>}
        </a>
        {merged ? (
          <span className="chip merged"><GitMerge size={12} /> PR влит</span>
        ) : pr?.state === 'CLOSED' ? (
          <span className="chip">PR закрыт</span>
        ) : (
          <Button
            tone="approve"
            className="merge-btn"
            icon={<GitMerge size={14} />}
            busy={busy === 'prMerge'}
            disabled={!pr || pr.conflicts || ciState === 'failed' || ciState === 'pending'}
            title={pr?.conflicts ? 'Конфликт с базовой веткой — разрешите на GitHub' : ciState === 'failed' ? 'Проверки CI упали' : ciState === 'pending' ? 'Ждём проверки CI' : pr?.blocked ? 'GitHub может потребовать ревью или обязательные проверки' : 'gh pr merge --merge'}
            onClick={() => void act('prMerge')}
          >
            Влить PR
          </Button>
        )}
        {error && <span className="merge-error" title={error}>{error}</span>}
      </span>
    );
  }

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
      <label className="select" title="Ветка, в которую влить результат или открыть PR">
        <span>в</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy !== null || !branches.length}>
          {!branches.length && <option value="">ветки не найдены</option>}
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <ChevronDown size={13} />
      </label>
      <Button
        tone="ghost"
        className="merge-btn"
        icon={<GitPullRequest size={14} />}
        busy={busy === 'pr'}
        disabled={!target || prWhy !== null || busy !== null}
        title={prWhy ?? 'Отправить ветку на GitHub и открыть Pull Request с описанием из прогона'}
        onClick={() => void act('pr')}
      >
        Создать PR
      </Button>
      <Button tone="approve" className="merge-btn" icon={<GitMerge size={14} />} busy={busy === 'merge'} disabled={!target || busy !== null} onClick={() => void act('merge')} title="Влить локально, без GitHub">
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
      {big && <Lightbox src={big} onClose={() => setBig(null)} />}
    </>
  );
}

function Metrics({ run }: { run: RunFile }) {
  const now = useNow(run);
  const clock = activeClock(run, now);
  const runs = run.attempts.filter((a) => !isGate(a.stage)).length;
  const humanMs = run.attempts.filter((a) => isGate(a.stage)).reduce((n, a) => n + ((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt)), 0);
  const total = usageTotal(run.totals);
  return (
    <dl className="metrics-row">
      <div className="stat" title={clock.paused > 0 ? `Без простоя ${ms(clock.paused)} после ошибок и остановок` : undefined}>
        <dt>Активное время</dt><dd><Num animate={false} text={ms(clock.total)} /></dd>
        {clock.paused > 0 && <span className="stat-note">простой {ms(clock.paused)} не учтён</span>}
      </div>
      <div className="stat"><dt>Ждали вас</dt><dd><Num animate={false} text={ms(humanMs)} /></dd></div>
      <div className="stat"><dt>Запусков стадий</dt><dd><Num text={String(runs)} /></dd></div>
      <div className="stat" title={`вход ${run.totals.input}, выход ${run.totals.output}, кэш ${run.totals.cacheRead + run.totals.cacheWrite}`}><dt>Токены</dt><dd><Num text={total ? tokens(total) : '—'} /></dd></div>
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

/** Баг: доказательство воспроизведения. Рефакторинг: зелёный эталон до начала. */
function ReproView({ run, kind }: { run: RunFile; kind: 'bug' | 'baseline' }) {
  const r = run.repro;
  if (!r) return <Empty icon={<Sparkles />} title={kind === 'bug' ? 'Баг ещё не воспроизведён' : 'Базовые проверки ещё не запускались'} />;
  const ok = kind === 'bug' ? !r.passed : r.passed;
  const failedCheck = r.checks?.find((c) => !c.passed);
  return (
    <div className={`repro ${ok ? 'is-ok' : 'is-bad'}`}>
      <strong>
        {kind === 'bug'
          ? (ok ? 'Баг воспроизведён: проверки красные на текущем коде' : 'Тест не воспроизвёл баг — проверки зелёные')
          : (ok ? 'Проверки зелёные до рефакторинга — эталон зафиксирован' : 'Проверки красные ещё до рефакторинга')}
      </strong>
      {(failedCheck ?? r.checks?.[0]) && <pre className="output">{stripAnsi((failedCheck ?? r.checks![0]).output).split('\n').slice(-18).join('\n')}</pre>}
    </div>
  );
}

/** Визуальная проверка: вердикт и галерея скриншотов. */
function VisualView({ run, runId, idx, attempt }: { run: RunFile; runId: string; idx: number; attempt?: StageAttempt }) {
  const running = attempt?.status === 'running';
  // Результат — только у завершённой попытки; у упавшей (сбой агента) или идущей — сразу лог.
  const v = running || (attempt && attempt.status === 'failed' && !run.visuals?.[idx]) ? undefined : run.visuals?.[idx];
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [big, setBig] = useState<number | null>(null);
  const [tab, setTab] = useState<'result' | 'server' | 'log'>(v ? 'result' : 'log');
  useEffect(() => {
    let alive = true;
    if (!v) return;
    void Promise.all(v.shots.map(async (s) => [s.file, await window.psflow.core.getVisualShot(runId, s.file)] as const)).then((pairs) => {
      // Удалённый очисткой хранилища скриншот — пустая строка: показываем заглушку, а не вечный спиннер.
      if (alive) setUrls(Object.fromEntries(pairs.map(([f, u]) => [f, u ?? ''])));
    });
    return () => { alive = false; };
  }, [runId, v]);
  const slice: LogSlice | null = attempt ? { title: 'Визуальная проверка', attempt: attempt.attempt, stage: 'visual', live: running } : null;
  if (!v && !slice) return <Empty icon={<Sparkles />} title="Визуальной проверки ещё не было">Приложение запустится после ревью.</Empty>;
  const items = v ? [...v.blocking.map((x) => ({ ...x, kind: 'blocking' as const })), ...v.notes.map((x) => ({ ...x, kind: 'note' as const }))] : [];
  const shown = v ? tab : 'log';
  const shotUrls = v ? v.shots.map((s) => urls[s.file]).filter(Boolean) : [];
  return (
    <div className="agent-out">
      {v && (
        <div className="agent-out-tabs">
          <PillTabs<'result' | 'server' | 'log'>
            className="tabs small"
            value={shown}
            onChange={setTab}
            items={[
              { id: 'result', label: 'Результат' },
              ...(v.serverOutput ? [{ id: 'server' as const, label: 'Вывод сервера' }] : []),
              { id: 'log', label: 'Лог' },
            ]}
          />
        </div>
      )}
      {shown === 'log' && slice ? (
        <div className="pane-log"><LiveLog runId={runId} slice={slice} /></div>
      ) : shown === 'server' && v?.serverOutput ? (
        <div className="agent-result scroll tab-enter"><ServerOutput command={v.command} output={v.serverOutput} /></div>
      ) : v ? (
    <div className="agent-result scroll tab-enter">
      <div className="review">
        {v.unverified ? (
          <div className="verdict is-warn">
            <span className="verdict-mark">!</span>
            <div>
              <strong>Проверить не удалось</strong>
              <p>{v.unverified}</p>
              <p className="muted">Это не ошибка реализации — задача не вернулась исполнителю. Проверьте сами во вкладке «Браузер»; тестовый вход и подготовку данных можно описать в «Инструкции для проверки» в командах проекта.</p>
            </div>
          </div>
        ) : null}
        {v.unverified && v.serverOutput && /error|Missing script|EADDRINUSE|ECONNREFUSED/i.test(v.serverOutput) && (
          <button className="link server-link" onClick={() => setTab('server')}>В выводе сервера есть ошибки — открыть</button>
        )}
        {!v.unverified && (
          <div className={`verdict ${v.blocking.length ? 'is-bad' : 'is-ok'}`}>
            <span className="verdict-mark">{v.blocking.length ? v.blocking.length : <CircleCheck size={22} />}</span>
            <div>
              <strong>{v.blocking.length ? `Видимых проблем: ${v.blocking.length}` : 'В браузере всё выглядит верно'}</strong>
              <p>{v.url} · скриншотов: {v.shots.length} · заметок: {v.notes.length}</p>
            </div>
          </div>
        )}
        <div className="shots">
          {v.shots.map((s) => (
            <figure key={s.file} className="shot">
              <button onClick={() => urls[s.file] && setBig(shotUrls.indexOf(urls[s.file]))}>{urls[s.file] ? <img src={urls[s.file]} alt={s.caption} /> : urls[s.file] === '' ? <span className="muted shot-gone">Скриншот удалён</span> : <span className="spinner" />}</button>
              <figcaption>{s.caption}</figcaption>
            </figure>
          ))}
        </div>
        {items.length > 0 && (
          <ul className="review-list">
            {items.map((x, i) => (
              <li key={i} className={`note n-${x.kind}`}>
                {x.file && <span className="note-loc">{x.file}</span>}
                <p>{x.message}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
      ) : null}
      {big !== null && shotUrls[big] && <Lightbox src={shotUrls[big]} caption={v?.shots.find((s) => urls[s.file] === shotUrls[big])?.caption} onClose={() => setBig(null)} onPrev={big > 0 ? () => setBig(big - 1) : undefined} onNext={big < shotUrls.length - 1 ? () => setBig(big + 1) : undefined} />}
    </div>
  );
}

/** Просмотр изображения на всё окно (через портал — не зависит от прокрутки и анимаций панели). ←/→ — соседние, Esc — закрыть. */
function Lightbox({ src, caption, onClose, onPrev, onNext }: { src: string; caption?: string; onClose: () => void; onPrev?: () => void; onNext?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onPrev?.();
      else if (e.key === 'ArrowRight') onNext?.();
      else return;
      // Esc и стрелки не должны дойти до экрана прогона (там они закрывают детали и листают стадии).
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, onPrev, onNext]);
  return createPortal(
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Изображение">
      <img src={src} alt={caption ?? ''} onClick={(e) => e.stopPropagation()} />
      {caption && <p className="lightbox-caption">{caption}</p>}
      {onPrev && <button className="lightbox-nav is-prev" onClick={(e) => { e.stopPropagation(); onPrev(); }} aria-label="Предыдущий">‹</button>}
      {onNext && <button className="lightbox-nav is-next" onClick={(e) => { e.stopPropagation(); onNext(); }} aria-label="Следующий">›</button>}
    </div>,
    document.body,
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
  if (!t) return <Empty icon={<Sparkles />} title="Проверки ещё не запускались" />;
  const checks = t.checks?.length ? t.checks : t.command ? [{ kind: 'test' as const, command: t.command, passed: t.passed, exitCode: t.exitCode, durationMs: t.durationMs, output: t.output, timedOut: t.timedOut }] : [];
  return (
    <div className="scroll">
      <div className="tests">
        {!checks.length && <p className="muted">{t.output}</p>}
        {checks.map((c, i) => (
          <section key={i} className="check-block">
            <div className={`tests-head ${c.passed ? 'is-ok' : c.preexisting ? 'is-old' : 'is-bad'}`}>
              <strong>{c.kind === 'lint' ? 'Линтер' : 'Тесты'} · {c.passed ? 'ok' : c.preexisting ? 'красные и до задачи' : 'красные'}</strong>
              <span className="mono">{c.command}</span>
              <span className="muted">код {c.exitCode ?? '—'} · {(c.durationMs / 1000).toFixed(1)} с{c.timedOut ? ' · таймаут' : ''}</span>
            </div>
            {c.preexisting && (
              <p className="check-old">
                Проверка была красной ещё до правок агента, новых ошибок не появилось ({c.preexisting.before ?? '?'} → {c.preexisting.after ?? '?'}). Не блокирует — старые ошибки лучше чинить отдельной задачей.
              </p>
            )}
            <pre className="output">{stripAnsi(c.output) || 'нет вывода'}</pre>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Вывод команды запуска: строки с ошибками подсвечены, частые причины — подсказкой. */
function ServerOutput({ command, output }: { command?: string; output: string }) {
  const lines = stripAnsi(output).split(/\r?\n/).filter((l) => l.trim()).slice(-30);
  const bad = (l: string) => /error|ERR!|Missing script|not found|EADDRINUSE|ECONNREFUSED|Cannot find|failed/i.test(l);
  const missing = output.match(/Missing script: "([^"]+)"/);
  const inUse = /EADDRINUSE|address already in use|Another next dev server/i.test(output);
  return (
    <section className="server-out">
      <header>
        <strong>Вывод команды запуска</strong>
        {command && <code>{command}</code>}
      </header>
      {missing && <p className="server-hint">В одном из package.json нет скрипта «{missing[1]}» — исправьте «Запуск приложения» в командах проекта (например, у NestJS это обычно <code>start:dev</code>).</p>}
      {inUse && <p className="server-hint">Порт или каталог уже заняты другим запущенным сервером — остановите его или смените порт в команде запуска.</p>}
      <pre className="output">{lines.map((l, i) => <span key={i} className={bad(l) ? 'is-err' : undefined}>{l}{'\n'}</span>)}</pre>
    </section>
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
  onOpenApp?: () => void;
  onAccept?: () => void;
  onFix?: () => void;
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
          placeholder={gate === 'limit' ? 'Подсказка исполнителю (необязательно)' : gate === 'gate2' ? 'Что поправить — например: «кнопку сделать синей», «добавить пустое состояние»' : 'Что доработать'}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <div className="gate-actions">
        {error && <span className="actionbar-error">{error}</span>}
        {props.onOpenApp && <Button tone="quiet" icon={<Globe size={14} />} onClick={props.onOpenApp}>Проверить в браузере</Button>}
        {!props.diffShown && gate !== 'limit' && <Button tone="quiet" onClick={props.onOpenAccept}>{gate === 'gate1' ? 'Открыть план' : 'Открыть дифф'}</Button>}
        {gate === 'gate1' && <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>Отменить задачу</Button>}
        {gate === 'limit' ? (
          <>
            <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>Остановить</Button>
            {props.onAccept && <Button tone="ghost" icon={<ClipboardCheck size={14} />} busy={busy === 'accept'} onClick={props.onAccept} title="Посмотреть дифф и решить самому — без новых попыток">К приёмке как есть</Button>}
            <Button tone="primary" icon={<RotateCcw size={14} />} busy={busy === 'approve'} onClick={props.onApprove}>Ещё попытка</Button>
          </>
        ) : (
          <>
            {needsComment && !open && lineCount === 0 ? (
              <Button tone="ghost" icon={<RotateCcw size={14} />} onClick={() => setOpen(true)}>{gate === 'gate2' ? 'Есть замечания' : 'Вернуть с комментарием'}</Button>
            ) : (
              <>
                {gate === 'gate2' && props.onFix && (
                  <Button
                    tone="ghost"
                    icon={<Wrench size={14} />}
                    busy={busy === 'fix'}
                    disabled={!comment.trim() && lineCount === 0}
                    onClick={props.onFix}
                    title="Небольшая правка в той же ветке: реализация → проверки → снова приёмка, без ревью и визуальной проверки"
                  >
                    Поправить{lineCount ? ` (+${lineCount})` : ''}
                  </Button>
                )}
                <Button
                  tone="ghost"
                  icon={<RotateCcw size={14} />}
                  busy={busy === 'reject'}
                  disabled={!comment.trim() && lineCount === 0}
                  onClick={props.onReject}
                  title={gate === 'gate2' ? 'Полный круг: реализация → проверки → ревью → визуальная проверка' : undefined}
                >
                  {gate === 'gate2' ? 'Вернуть на доработку' : `Вернуть${lineCount ? ` (+${lineCount})` : ''}`}
                </Button>
              </>
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

/** Стадия агента: итоговый ответ в Markdown отдельно от служебного лога. */
function AgentOutput({ runId, slice, attempt }: { runId: string; slice: LogSlice; attempt: StageAttempt }) {
  const running = attempt.status === 'running';
  const [fromLog, setFromLog] = useState<string | null>(null);
  const [tab, setTab] = useState<'result' | 'log'>(running ? 'log' : 'result');
  useEffect(() => {
    if (running || attempt.output) return;
    let alive = true;
    void window.psflow.core.getLog(runId).then((full) => alive && setFromLog(finalMessage(cut(full, slice))));
    return () => {
      alive = false;
    };
  }, [runId, slice.title, slice.attempt, running, attempt.output]);
  useEffect(() => {
    if (!running) setTab('result');
  }, [running]);
  const result = attempt.output ?? fromLog;
  const hasResult = !running && Boolean(result);
  const shown = hasResult ? tab : 'log';
  return (
    <div className="agent-out">
      {hasResult && (
        <div className="agent-out-tabs">
          <PillTabs<'result' | 'log'>
            className="tabs small"
            value={shown}
            onChange={setTab}
            items={[
              { id: 'result', label: 'Результат' },
              { id: 'log', label: 'Лог' },
            ]}
          />
        </div>
      )}
      {shown === 'result' && result ? (
        <div className="agent-result scroll tab-enter">
          <Markdown source={result} />
        </div>
      ) : (
        <div className="pane-log"><LiveLog runId={runId} slice={slice} /></div>
      )}
    </div>
  );
}
