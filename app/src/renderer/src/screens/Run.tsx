import { useEffect, useRef, useState } from 'react';
import {
  MessageCircleQuestion,
  ArrowRight,
  ChevronDown,
  FileText,
  Paperclip,
  CircleStop,
  FolderOpen,
  MousePointerClick,
  GitBranch,
  Play,
  SkipForward,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { StageId } from '@purpleflow/core';
import { STAGE_ICON } from '../components/StageRail';
import { PillTabs } from '../components/PillTabs';
import { Timeline } from '../components/Timeline';
import { isGate } from '../lib/bars';
import { MODES, acceptTarget, limitRow, nodeState, runStages, type Mode } from '../lib/stages';
import { MODE_ICON } from '../components/ModeIcon';
import { LiveLog, type LogSlice } from '../components/Terminal';
import { AgentScreen, BrowserPane, useAgentScreen, usePreview } from '../components/BrowserPane';
import { PrPane } from '../components/PrPane';
import { Button, Empty, StatusPill } from '../components/ui';
import { onCoreEvent, useStore } from '../lib/store';
import { shortPath } from '../lib/format';
import type { ChangeDocs } from '../../../shared/ipc';
import { GateBar } from './run/GateBar';
import { Attachments, Banner, DeleteRun, LongRunBanner, MergeControl, MetricsInline, Warnings } from './run/RunHeader';
import { ManagerChat, useManagerLayout } from './run/ManagerChat';
import { CodePane, useChangedFiles } from './run/CodePane';
import { AgentOutput, ClarifyView, InProgress, PlanView, ReproView, ReviewView, TestsView, VisualView } from './run/StageViews';
import { LOG_TITLE, cleanErr, currentStage, unstableText, withPicked } from './run/util';
import { useRunGate } from './run/useRunGate';

type View = 'timeline' | 'log' | 'browser' | 'code' | 'pr';

export function RunScreen({ runId }: { runId: string }) {
  const { state, loadRun, go } = useStore();
  const run = state.details[runId];
  const [view, setView] = useState<View>('timeline');
  /** Стадия, чьи детали открыты в выезжающей панели; null — панель закрыта. */
  const [drawer, setDrawer] = useState<StageId | null>(null);
  /** Выбранная попытка стадии; null — последняя. */
  const [attemptNo, setAttemptNo] = useState<number | null>(null);
  const [docs, setDocs] = useState<ChangeDocs | null>(null);
  const { comment, setComment, lineComments, setLineComments, picked, setPicked, accTab, setAccTab } = useRunGate(runId);
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
    void window.purpleflow.core
      .getProjectConfig(projectPath)
      .then((c) => alive && setProjectRun(Boolean(c?.runCommand && c.appUrl)))
      .catch(() => {});
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
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    void loadRun(runId);
    setView('timeline');
    setDrawer(null);
    setAttemptNo(null);
    setDocs(null);
    setError(null);
    gateKey.current = '';
  }, [runId, loadRun]);

  // Гейт ждёт решения — сами открываем детали этой стадии: план, а приёмку — на вкладке «Код».
  useEffect(() => {
    if (!run) return;
    const key = `${run.next}:${run.status}`;
    if (key === gateKey.current) return;
    gateKey.current = key;
    if (run.status === 'waiting' && run.next === 'gate2') {
      setDrawer(null);
      setView('code');
    } else if (run.status === 'waiting') {
      setView('timeline');
      setDrawer(run.next === 'limit' ? limitRow(run) : run.next === 'gate0' ? 'clarify' : run.next);
      setAttemptNo(null);
    }
  }, [run]);

  const showPlan = drawer === 'plan' || drawer === 'gate1';

  const refreshDocs = () =>
    window.purpleflow.core
      .getChangeDocs(runId)
      .then(setDocs)
      .catch(() => setDocs(null));
  useEffect(() => {
    if (showPlan) void refreshDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlan, runId, run?.next, run?.status]);

  useEffect(
    () =>
      onCoreEvent((e) => {
        if (e.type === 'stage.started' && e.runId === runId && showPlan) void refreshDocs();
         
      }),
    [runId, showPlan],
  );

  const open = (s: StageId) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setClosing(false);
    // Приёмка — это дифф: открываем вкладку «Код», а не панель деталей.
    if (s === 'gate2') {
      setDrawer(null);
      setView('code');
      return;
    }
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
      const order = runStages(run)
        .map((x) => x.id)
        .filter((id) => run.attempts.some((a) => a.stage === id) || id === run.next);
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

  // До проверки «прогон загружен»: порядок хуков не должен зависеть от загрузки.
  const changed = useChangedFiles(run);
  const managerLayout = useManagerLayout();
  /** Место в строке вкладок для инструментов вкладки «Код»: «Код / Заметки» и «Обновить». */
  const [tabTools, setTabTools] = useState<HTMLDivElement | null>(null);

  if (!run) {
    return (
      <div className="screen">
        <div className="scroll center">
          <span className="spinner big" />
        </div>
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
  const dispatch = window.purpleflow.core.dispatch;
  const agentLive = Boolean(agentScreen.frame) || (run.status === 'running' && run.next === 'visual');
  const canRunApp = projectRun || Boolean(run.runCommand && run.appUrl) || preview.state.status !== 'idle';
  const openApp = () => {
    setView('browser');
    setDrawer(null);
    if (preview.state.status === 'idle' || preview.state.status === 'failed') void preview.start();
  };

  const live = run.status === 'running' || run.status === 'waiting';
  const resumable = run.status === 'stopped';
  // Реализация уже хоть раз завершилась, а прогон крутится между ней и проверками — можно не ждать зелёных тестов.
  const canSkipChecks =
    (live || resumable) &&
    (run.next === 'implement' || run.next === 'tests') &&
    run.attempts.some((a) => a.stage === 'implement' && a.status === 'done');
  const gate =
    run.status === 'waiting' || (run.status === 'stopped' && (run.next === 'gate1' || run.next === 'gate2' || run.next === 'limit'))
      ? run.next
      : null;
  const lastReview = run.reviews[run.reviews.length - 1];
  const stageDef = drawer ? runStages(run).find((x) => x.id === drawer) : undefined;
  const testIdx = Math.min(run.tests.length - 1, attemptIdx < 0 ? run.tests.length - 1 : attemptIdx);
  const reviewIdx = Math.min(run.reviews.length - 1, attemptIdx < 0 ? run.reviews.length - 1 : attemptIdx);
  const clarifyQuestions = drawer === 'clarify' && run.clarify?.questions.length ? run.clarify : null;
  // Идущая попытка стадии, у которой результат появляется только в конце: вместо прошлой попытки — заглушка.
  const unstableChecks = (run.tests.at(-1)?.checks ?? []).filter((x) => x.unstable);
  const lastVisual = run.visuals?.at(-1);
  const accNotes =
    (lastReview ? lastReview.blocking.length + lastReview.notes.length : 0) +
    (lastVisual ? lastVisual.blocking.length + lastVisual.notes.length : 0) +
    lineComments.length;
  const inProgress = Boolean(attempt?.status === 'running' && (drawer === 'tests' || drawer === 'review' || drawer === 'plan'));
  const slice: LogSlice | undefined =
    drawer && attempt && LOG_TITLE[drawer] && !clarifyQuestions
      ? { title: LOG_TITLE[drawer]!, attempt: attempt.attempt, stage: drawer, live: attempt.status === 'running' }
      : undefined;

  const gateBar =
    gate === 'gate0' ? (
      <div className="gatebar is-gate">
        <div className="gate-sign" aria-hidden>
          <MessageCircleQuestion size={17} />
        </div>
        <div className="gate-text">
          <strong>Вопросы перед планом</strong>
          <span>Ответьте выше — ответы получат все стадии. Можно продолжить и без них: планировщик решит сам.</span>
        </div>
        <div className="gate-actions">
          {error && <span className="actionbar-error">{error}</span>}
          <Button tone="quiet" busy={busy === 'cancel'} onClick={() => act('cancel', () => dispatch({ type: 'gate.cancel', runId }))}>
            Отменить задачу
          </Button>
          <Button
            tone="ghost"
            busy={busy === 'skip'}
            onClick={() => act('skip', () => dispatch({ type: 'gate.answer', runId, answers: [] }))}
          >
            Продолжить без ответов
          </Button>
        </div>
      </div>
    ) : (
      gate && (
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
          acceptTo={gate === 'limit' ? acceptTarget(run) : undefined}
          onFix={
            gate === 'gate2'
              ? () =>
                  act('fix', () =>
                    dispatch({ type: 'gate.fix', runId, comment: withPicked(comment, picked), lineComments }).then(() => setPicked([])),
                  )
              : undefined
          }
          pickedCount={gate === 'gate2' ? picked.length : 0}
          onOpenAccept={() => open(gate === 'gate1' ? 'gate1' : 'gate2')}
          onOpenApp={gate === 'gate2' && canRunApp && view !== 'browser' ? openApp : undefined}
          diffShown={gate === 'gate1' ? showPlan : view === 'code'}
        />
      )
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
              {run.attachments?.length ? (
                <span className="desc-count">
                  <Paperclip size={12} />
                  {run.attachments.length}
                </span>
              ) : null}
              <ChevronDown size={14} className="desc-chev" />
            </button>
          </div>
          {!run.titleFromPlan && run.status === 'running' && <span className="title-hint">Название придумает планировщик</span>}
          <div className={`desc ${descOpen ? 'is-open' : ''}`}>
            <div className="desc-inner">
              <p className="desc-text">{run.task}</p>
              {run.attachments?.length ? <Attachments runId={runId} files={run.attachments} /> : null}
            </div>
          </div>
          <div className="run-meta">
            <StatusPill status={run.status} />
            <span className="chip mode-chip">
              {MODE_ICON[(run.mode ?? 'task') as Mode]} {MODES.find((m) => m.id === (run.mode ?? 'task'))?.title}
              {run.mode === 'epic' && run.phases ? ` · этап ${Math.min(run.phase ?? 1, run.phases)}/${run.phases}` : ''}
            </span>
            {run.autopilot && (
              <span className="chip" title="План принимается сам, при исчерпанных попытках — одна попытка сама">
                Автопилот
              </span>
            )}
            <span className="chip mono" title={run.branch}>
              <GitBranch size={12} /> {run.branch}
            </span>
            {run.status === 'finished' && <MergeControl run={run} runId={runId} />}
            <span className="muted mono path" title={run.projectPath}>
              {shortPath(run.projectPath)}
            </span>
          </div>
          <MetricsInline run={run} />
        </div>
        <div className="run-actions">
          <Button
            tone="quiet"
            icon={<FolderOpen size={16} />}
            title={run.workspace === 'branch' ? 'Открыть папку проекта' : 'Открыть worktree'}
            onClick={() => void window.purpleflow.openPath(run.worktreePath)}
          />
          <DeleteRun run={run} runId={runId} />
          {(resumable || run.status === 'queued') && !gate && (
            <Button
              tone="ghost"
              icon={<Play size={14} />}
              busy={busy === 'resume'}
              onClick={() => act('resume', () => dispatch({ type: 'run.resume', runId }))}
            >
              {run.status === 'queued' || run.workspacePending ? 'Запустить сейчас' : 'Продолжить'}
            </Button>
          )}
          {run.status === 'finished' && run.nextParts && (
            <Button
              tone="primary"
              icon={<ArrowRight size={14} />}
              busy={busy === 'next'}
              title="Новая задача со следующей частью из раздела «Next Parts» плана — с исходным ТЗ и вложениями"
              onClick={() =>
                act('next', async () => {
                  const d = await window.purpleflow.core.nextPartDraft(runId);
                  if (d) go({ name: 'new', project: d.projectPath, draft: d });
                })
              }
            >
              Следующая часть
            </Button>
          )}
          {canSkipChecks && (
            <Button
              tone="ghost"
              icon={<SkipForward size={14} />}
              busy={busy === 'skip'}
              title="Остановить текущую попытку и перейти к ревью, не дожидаясь зелёных проверок"
              onClick={() => act('skip', () => dispatch({ type: 'run.skipChecks', runId }))}
            >
              Пропустить проверки
            </Button>
          )}
          {(live || run.status === 'queued') && (
            <Button
              tone="danger"
              icon={<CircleStop size={15} />}
              busy={busy === 'stop'}
              onClick={() => act('stop', () => dispatch({ type: 'run.stop', runId }))}
            >
              {run.status === 'queued' ? 'Снять с очереди' : 'Стоп'}
            </Button>
          )}
        </div>
      </header>

      <div className="run-body" style={managerLayout.style}>
        <ManagerChat run={run} runId={runId} layout={managerLayout} />

        <section className="run-main">
          <div className="tab-groups">
            <PillTabs<View>
              className="tabs"
              value={view}
              onChange={(v) => {
                setView(v);
                if (v !== 'timeline') {
                  setDrawer(null);
                  setClosing(false);
                }
              }}
              items={[
                { id: 'timeline', label: 'Таймлайн' },
                { id: 'log', label: 'Лог' },
                {
                  id: 'browser',
                  label: 'Браузер',
                  extra: agentScreen.frame ? (
                    <span className="tab-dot is-live" title="Агент работает в браузере" />
                  ) : preview.state.status === 'ready' ? (
                    <span className="tab-dot is-ok" />
                  ) : preview.state.status === 'starting' ? (
                    <span className="tab-live" />
                  ) : undefined,
                },
                { id: 'code', label: 'Код', extra: changed?.length ? <span className="tab-badge">{changed.length}</span> : undefined },
                ...(run.pr
                  ? [
                      {
                        id: 'pr' as const,
                        label: 'Pull Request',
                        extra: run.prRound && run.status !== 'finished' ? <span className="tab-live" /> : undefined,
                      },
                    ]
                  : []),
              ]}
            />
            {view === 'code' ? <div className="tab-tools" ref={setTabTools} /> : <span className="grow" />}
            {view === 'timeline' && !drawer && (
              <span className="tab-hint">
                <MousePointerClick size={14} /> Нажмите на стадию — откроются её детали
              </span>
            )}
          </div>

          <Banner run={run} />
          <LongRunBanner run={run} limitMin={state.settings?.agentTimeoutMin ?? 30} />
          <Warnings run={run} />

          <div className="tab-body">
            <div className={`pane ${view === 'log' ? '' : 'is-hidden'}`}>
              <LiveLog runId={runId} />
            </div>
            {/* Браузер не размонтируем при переключении вкладок — страница и её состояние сохраняются. */}
            {/* Пока идёт визуальная проверка — экран браузера агента; потом — своё приложение для ручной проверки. */}
            {view === 'browser' && agentLive && (
              <div className="pane pane-browser">
                <AgentScreen screen={agentScreen} />
              </div>
            )}
            {(view === 'browser' || preview.state.status === 'ready') && (
              <div className={`pane pane-browser ${view === 'browser' && !agentLive ? '' : 'is-hidden'}`}>
                <BrowserPane preview={preview} canRun={canRunApp} />
              </div>
            )}
            {view === 'code' && (
              <CodePane
                run={run}
                changed={changed}
                tools={tabTools}
                accept={
                  gate === 'gate2'
                    ? {
                        picked,
                        onPicked: setPicked,
                        tab: accTab,
                        onTab: setAccTab,
                        comments: lineComments,
                        onComments: setLineComments,
                        notes: accNotes,
                        summary:
                          run.changeSummary?.attempt === run.attempts.filter((a) => a.stage === 'gate2').length
                            ? run.changeSummary.text
                            : run.status === 'waiting'
                              ? null
                              : undefined,
                        banner:
                          unstableChecks.length > 0 ? (
                            <p className="check-old unstable-banner">
                              <TriangleAlert size={14} /> {unstableText(unstableChecks[0].unstable!)}
                            </p>
                          ) : undefined,
                      }
                    : undefined
                }
              />
            )}
            {view === 'pr' && run.pr && (
              <div className="pane">
                <PrPane run={run} runId={runId} onStarted={() => setView('timeline')} />
              </div>
            )}
            {view === 'timeline' && (
              <div className={`split ${drawer && !closing ? 'is-open' : ''}`}>
                <div className="split-left scroll">
                  <div className="timeline-panel">
                    <Timeline
                      run={run}
                      selected={drawer}
                      current={live ? currentStage(run) : null}
                      onSelect={open}
                      compact={Boolean(drawer) && !closing}
                    />
                  </div>
                </div>
                <div className="split-right">
                  {drawer && stageDef && (
                    <div className={`details ${closing ? 'is-closing' : ''}`} key={drawer}>
                      <header className="drawer-head">
                        <span className={`drawer-icon st-${nodeState(run, drawer)}`}>{STAGE_ICON[drawer]}</span>
                        <div className="drawer-title">
                          <strong>{stageDef.title}</strong>
                          <span>
                            {drawer === 'visual'
                              ? (run.agents?.visual ?? 'claude')
                              : stageDef.role
                                ? (run.agents?.[stageDef.role] ?? stageDef.actor)
                                : stageDef.actor}
                            {drawer === 'visual'
                              ? attempt?.model && attempt.model !== (run.agents?.visual ?? 'claude')
                                ? ` · ${attempt.model}`
                                : ''
                              : stageDef.role && run.models[stageDef.role]
                                ? ` · ${run.models[stageDef.role]}`
                                : ''}
                            {attempt?.summary ? ` — ${attempt.summary}` : ''}
                          </span>
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
                        {inProgress && <InProgress stage={drawer} attempt={attempt} />}
                        {showPlan && !inProgress && run.mode === 'bug' && run.repro && <ReproView run={run} kind="bug" />}
                        {showPlan && !inProgress && (
                          <PlanView
                            docs={docs}
                            run={run}
                            comments={lineComments}
                            onComments={setLineComments}
                            editable={gate === 'gate1'}
                          />
                        )}
                        {slice && attempt && (
                          <AgentOutput key={`${drawer}-${slice.attempt}`} runId={runId} slice={slice} attempt={attempt} />
                        )}
                        {drawer === 'tests' && !inProgress && <TestsView run={run} idx={testIdx} />}
                        {drawer === 'review' && !inProgress && (
                          <ReviewView
                            run={run}
                            idx={reviewIdx}
                            {...(gate === 'gate2' && reviewIdx === run.reviews.length - 1 ? { picked, onPicked: setPicked } : {})}
                          />
                        )}
                        {drawer === 'visual' && (
                          <VisualView
                            key={`visual-${attempt?.attempt ?? 0}`}
                            run={run}
                            runId={runId}
                            attempt={attempt}
                            idx={Math.min((run.visuals?.length ?? 1) - 1, attemptIdx < 0 ? (run.visuals?.length ?? 1) - 1 : attemptIdx)}
                          />
                        )}
                        {drawer === 'baseline' && <ReproView run={run} kind="baseline" />}
                        {clarifyQuestions && (
                          <ClarifyView
                            run={run}
                            runId={runId}
                            waiting={run.next === 'gate0' && (run.status === 'waiting' || run.status === 'stopped')}
                            onDone={close}
                          />
                        )}
                        {!showPlan &&
                          !slice &&
                          drawer !== 'tests' &&
                          drawer !== 'review' &&
                          drawer !== 'visual' &&
                          drawer !== 'baseline' &&
                          !clarifyQuestions && (
                            <Empty icon={<Sparkles />} title={`${stageDef.title} ещё не начиналась`}>
                              Стадия запустится, когда до неё дойдёт прогон.
                            </Empty>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {gateBar}
          {!gate && error && (
            <div className="gatebar">
              <span className="actionbar-error">{error}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
