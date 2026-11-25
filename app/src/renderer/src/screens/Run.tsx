// Экран прогона: шапка, чат менеджера, вкладки (таймлайн с деталями стадий, лог, браузер, код, замечания, PR) и панель решения на гейте.
import {
  ChartGantt,
  FileCode2,
  FolderTree,
  GitBranch,
  GitPullRequest,
  MessageSquareText,
  Globe,
  MousePointerClick,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';
import { GitView } from '../components/GitView';
import { ChatFiles } from './ChatFiles';
import { useEffect, useRef, useState } from 'react';
import { AgentScreen, BrowserPane, useAgentScreen, usePreview } from '../components/BrowserPane';
import { PillTabs } from '../components/PillTabs';
import { PrPane } from '../components/PrPane';
import { LiveLog } from '../components/Terminal';
import { Timeline } from '../components/Timeline';
import { bridge, cleanErr } from '../lib/api';
import { acceptTarget, limitRow } from '../lib/stages';
import { useStore } from '../lib/store';
import { CodePane, useChangedFiles } from './run/CodePane';
import { ClarifyGateBar, GateBar } from './run/GateBar';
import { ManagerChat, useManagerLayout } from './run/ManagerChat';
import { Banner, LongRunBanner, Warnings } from './run/RunHeader';
import { RunTitle } from './run/RunTitle';
import { StageDrawer } from './run/StageDrawer';
import { useRunGate } from './run/useRunGate';
import { useStageDrawer } from './run/useStageDrawer';
import { MergeCheckNote, useMergeCheck } from './run/MergeCheckNote';
import { currentStage, reviewFixText, unstableText, withPicked } from './run/util';

type View = 'timeline' | 'log' | 'browser' | 'code' | 'notes' | 'files' | 'git' | 'pr';

/** Решения на гейте: после них детали (план, дифф) сворачиваются и снова виден весь таймлайн. */
const GATE_ACTIONS = ['approve', 'reject', 'cancel', 'accept', 'fix', 'skip'];

export function RunScreen({ runId }: { runId: string }) {
  const { state, loadRun, go } = useStore();
  const run = state.details[runId];
  const [view, setView] = useState<View>('timeline');
  const d = useStageDrawer(run, () => setView('code'));
  const { comment, setComment, lineComments, setLineComments, picked, setPicked } = useRunGate(runId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gateKey = useRef('');
  const preview = usePreview(runId);
  const agentScreen = useAgentScreen(runId);
  /** Команды проекта: у прогонов до вкладки «Браузер» команда запуска не сохранена в run.json. */
  const [projectRun, setProjectRun] = useState(false);
  const projectPath = run?.projectPath;
  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    void bridge.core
      .getProjectConfig(projectPath)
      .then((c) => alive && setProjectRun(Boolean(c?.runCommand && c.appUrl)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectPath]);

  useEffect(() => {
    void loadRun(runId);
    setView('timeline');
    d.reset();
    setError(null);
    gateKey.current = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сброс экрана только при переходе к другому прогону
  }, [runId, loadRun]);

  // Гейт ждёт решения — сами открываем детали этой стадии: план, а приёмку — на вкладке «Код».
  useEffect(() => {
    if (!run) return;
    const key = `${run.next}:${run.status}`;
    if (key === gateKey.current) return;
    gateKey.current = key;
    if (run.status === 'waiting' && run.next === 'gate2') {
      d.reset();
      // Ревью кода: главное — замечания; если их нет, смотреть остаётся код.
      const r = run.reviews.at(-1);
      setView(run.mode === 'review' && r && r.blocking.length + r.notes.length > 0 ? 'notes' : 'code');
    } else if (run.status === 'waiting') {
      setView('timeline');
      d.open(run.next === 'limit' ? limitRow(run) : run.next === 'gate0' ? 'clarify' : run.next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем на смену стадии и статуса прогона
  }, [run]);

  const openStage: typeof d.open = (s) => {
    if (s !== 'gate2') setView('timeline');
    d.open(s);
  };

  // До проверки «прогон загружен»: порядок хуков не должен зависеть от загрузки.
  const changed = useChangedFiles(run);
  const managerLayout = useManagerLayout();
  /** Место в строке вкладок для инструментов вкладок «Код» и «Замечания»: «Обновить». */
  const [tabTools, setTabTools] = useState<HTMLDivElement | null>(null);
  // На приёмке: базовая ветка ушла вперёд или те же файлы правит другой прогон — видно до решения, а не при влитии.
  const mergeCheck = useMergeCheck(
    run,
    run?.baseBranch?.replace(/^origin\//, ''),
    run?.next === 'gate2' && run.status === 'waiting' && run.mode !== 'review',
  );

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
      if (GATE_ACTIONS.includes(name)) {
        setView('timeline');
        d.close();
      }
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };
  const dispatch = bridge.core.dispatch;
  const agentLive = agentScreen.live || (run.status === 'running' && run.next === 'visual');
  const canRunApp = projectRun || Boolean(run.runCommand && run.appUrl) || preview.state.status !== 'idle';
  const openApp = () => {
    setView('browser');
    d.reset();
    if (preview.state.status === 'idle' || preview.state.status === 'failed') void preview.start();
  };

  const live = run.status === 'running' || run.status === 'waiting';
  const gate =
    run.status === 'waiting' || (run.status === 'stopped' && (run.next === 'gate1' || run.next === 'gate2' || run.next === 'limit'))
      ? run.next
      : null;
  const showPlan = d.drawer === 'plan' || d.drawer === 'gate1';
  const lastReview = run.reviews.at(-1);
  const lastVisual = run.visuals?.at(-1);
  const unstableChecks = (run.tests.at(-1)?.checks ?? []).filter((x) => x.unstable);
  const accNotes =
    (lastReview ? lastReview.blocking.length + lastReview.notes.length : 0) +
    (lastVisual ? lastVisual.blocking.length + lastVisual.notes.length : 0) +
    lineComments.length;
  /** Вкладка «Замечания» — когда ревьюер или визуальная проверка уже что-то сказали, или на приёмке (там и свои замечания). */
  const hasNotes = run.reviews.length > 0 || Boolean(run.visuals?.length) || gate === 'gate2';

  const codeReview = run.mode === 'review' && gate === 'gate2';
  /** Ревью кода: завершить разбор и отнести выбранное туда, где исправят, — в новую задачу или, для незакоммиченных правок, в чат. */
  const fixReview = () =>
    act('fix', async () => {
      const text = reviewFixText(run.review?.label ?? 'код', comment, picked, lineComments);
      await dispatch({ type: 'gate.approve', runId, comment: text });
      setPicked([]);
      if (run.review?.target.kind === 'uncommitted') go({ name: 'chat', project: run.projectPath, text });
      else go({ name: 'new', draft: { projectPath: run.projectPath, task: text, attachments: [], baseBranch: run.baseBranch, rest: [] } });
    });

  const gateBar =
    gate === 'gate0' ? (
      <ClarifyGateBar
        busy={busy}
        error={error}
        onCancel={() => act('cancel', () => dispatch({ type: 'gate.cancel', runId }))}
        onSkip={() => act('skip', () => dispatch({ type: 'gate.answer', runId, answers: [] }))}
      />
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
          stuck={gate === 'limit' ? run.stuck?.items : undefined}
          codeReview={
            codeReview
              ? {
                  fixTo: run.review?.target.kind === 'uncommitted' ? 'chat' : 'task',
                  findings: (lastReview?.blocking.length ?? 0) + (lastReview?.notes.length ?? 0),
                }
              : undefined
          }
          onFix={
            codeReview
              ? () => void fixReview()
              : gate === 'gate2'
                ? () =>
                    act('fix', () =>
                      dispatch({ type: 'gate.fix', runId, comment: withPicked(comment, picked), lineComments }).then(() => setPicked([])),
                    )
                : undefined
          }
          pickedCount={gate === 'gate2' ? picked.length : 0}
          onOpenAccept={() => openStage(gate === 'gate1' ? 'gate1' : 'gate2')}
          onOpenApp={gate === 'gate2' && canRunApp && view !== 'browser' ? openApp : undefined}
          diffShown={gate === 'gate1' ? showPlan : view === 'code' || view === 'notes'}
        />
      )
    );

  return (
    <div className="screen run run-v3">
      <RunTitle run={run} runId={runId} gate={gate} busy={busy} act={act} />

      <div className="run-body" style={managerLayout.style}>
        <ManagerChat run={run} runId={runId} layout={managerLayout} />

        <section className="run-main">
          <div className="tab-groups">
            <PillTabs<View>
              className="tabs"
              value={view}
              onChange={(v) => {
                setView(v);
                if (v !== 'timeline') d.reset();
              }}
              items={[
                { id: 'timeline', label: 'Таймлайн', icon: <ChartGantt size={15} /> },
                { id: 'log', label: 'Лог', icon: <ScrollText size={15} /> },
                {
                  id: 'browser',
                  label: 'Браузер',
                  icon: <Globe size={15} />,
                  extra: agentScreen.live ? (
                    <span className="tab-dot is-live" title="Агент работает в браузере" />
                  ) : preview.state.status === 'ready' ? (
                    <span className="tab-dot is-ok" />
                  ) : preview.state.status === 'starting' ? (
                    <span className="tab-live" />
                  ) : undefined,
                },
                {
                  id: 'code',
                  label: 'Код',
                  icon: <FileCode2 size={15} />,
                  extra: changed?.length ? <span className="tab-badge">{changed.length}</span> : undefined,
                },
                ...(hasNotes
                  ? [
                      {
                        id: 'notes' as const,
                        label: 'Замечания',
                        icon: <MessageSquareText size={15} />,
                        extra: picked.length ? (
                          <span className="tab-badge is-pick" title="Отмечено к исправлению">
                            {picked.length}
                          </span>
                        ) : accNotes ? (
                          <span className={`tab-badge ${lastReview?.blocking.length ? 'is-bad' : ''}`}>{accNotes}</span>
                        ) : undefined,
                      },
                    ]
                  : []),
                { id: 'files', label: 'Файлы', icon: <FolderTree size={15} /> },
                { id: 'git', label: 'Git', icon: <GitBranch size={15} /> },
                ...(run.pr
                  ? [
                      {
                        id: 'pr' as const,
                        label: 'Pull Request',
                        icon: <GitPullRequest size={15} />,
                        extra: run.prRound && run.status !== 'finished' ? <span className="tab-live" /> : undefined,
                      },
                    ]
                  : []),
              ]}
            />
            {view === 'code' || view === 'notes' ? <div className="tab-tools" ref={setTabTools} /> : <span className="grow" />}
            {view === 'timeline' && !d.drawer && (
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
            {(view === 'code' || view === 'notes') && (
              <CodePane
                run={run}
                changed={changed}
                tools={tabTools}
                tab={view}
                onTab={setView}
                accept={
                  gate === 'gate2'
                    ? {
                        picked,
                        onPicked: setPicked,
                        comments: lineComments,
                        onComments: setLineComments,
                        // Ревью кода сводку изменений не готовит — не показываем вечное «готовится».
                        summary: codeReview
                          ? undefined
                          : run.changeSummary?.attempt === run.attempts.filter((a) => a.stage === 'gate2').length
                            ? run.changeSummary.text
                            : run.status === 'waiting'
                              ? null
                              : undefined,
                        banner: (
                          <>
                            {unstableChecks.length > 0 && (
                              <p className="check-old unstable-banner">
                                <TriangleAlert size={14} /> {unstableText(unstableChecks[0].unstable!)}
                              </p>
                            )}
                            <div className="accept-merge-check">
                              <MergeCheckNote check={mergeCheck} />
                            </div>
                          </>
                        ),
                      }
                    : undefined
                }
              />
            )}
            {/* Файлы рабочей копии прогона — только просмотр: писать агенту здесь некому, кроме менеджера. */}
            {view === 'files' && (
              <div className="pane run-files">
                <ChatFiles projectPath={run.root?.dir ?? run.worktreePath} refresh={run.updatedAt ?? ''} />
              </div>
            )}
            {view === 'git' && (
              <div className="pane run-files">
                <div className="chat-code">
                  <GitView projectPath={run.projectPath} refresh={run.updatedAt ?? ''} focus={run.branch} />
                </div>
              </div>
            )}
            {view === 'pr' && run.pr && (
              <div className="pane">
                <PrPane run={run} runId={runId} onStarted={() => setView('timeline')} />
              </div>
            )}
            {view === 'timeline' && (
              <div className={`split ${d.drawer && !d.closing ? 'is-open' : ''}`}>
                <div className="split-left scroll">
                  <div className="timeline-panel">
                    <Timeline
                      run={run}
                      selected={d.drawer}
                      current={live ? currentStage(run) : null}
                      onSelect={openStage}
                      compact={Boolean(d.drawer) && !d.closing}
                    />
                  </div>
                </div>
                <div className="split-right">
                  {d.drawer && (
                    <StageDrawer
                      run={run}
                      runId={runId}
                      drawer={{ ...d, drawer: d.drawer }}
                      gate={gate}
                      comments={lineComments}
                      onComments={setLineComments}
                      picked={picked}
                      onPicked={setPicked}
                    />
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
