// Детали стадии справа от таймлайна: кто выполнял, попытки и результат стадии.
import type { LineComment, ReviewItem, RunFile, StageId } from '@purpleflow/core';
import { Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChangeDocs } from '../../../../shared/ipc';
import { PillTabs } from '../../components/PillTabs';
import { STAGE_ICON } from '../../components/StageRail';
import type { LogSlice } from '../../components/Terminal';
import { Button, Empty } from '../../components/ui';
import { bridge } from '../../lib/api';
import { nodeState, runStages } from '../../lib/stages';
import { onCoreEvent } from '../../lib/store';
import type { StageDrawerState } from './useStageDrawer';
import { LOG_TITLE } from './util';
import { ReproView, TestsView } from './views/ChecksViews';
import { ClarifyView } from './views/ClarifyView';
import { PlanView } from './views/PlanView';
import { AgentOutput, InProgress } from './views/Progress';
import { ReviewView } from './views/ReviewView';
import { VisualView } from './views/VisualView';

export function StageDrawer({
  run,
  runId,
  drawer: d,
  gate,
  comments,
  onComments,
  picked,
  onPicked,
}: {
  run: RunFile;
  runId: string;
  drawer: StageDrawerState & { drawer: StageId };
  /** Гейт, на котором ждёт прогон: на плане можно комментировать, на приёмке — отмечать замечания к исправлению. */
  gate: StageId | null;
  comments: LineComment[];
  onComments: (c: LineComment[]) => void;
  picked: ReviewItem[];
  onPicked: (items: ReviewItem[]) => void;
}) {
  const { drawer, attempt, attemptIdx, tries, closing, close } = d;
  const stageDef = runStages(run).find((x) => x.id === drawer);
  const showPlan = drawer === 'plan' || drawer === 'gate1';
  const docs = useChangeDocs(runId, showPlan, `${run.next}:${run.status}`);
  if (!stageDef) return null;

  const testIdx = Math.min(run.tests.length - 1, attemptIdx < 0 ? run.tests.length - 1 : attemptIdx);
  const reviewIdx = Math.min(run.reviews.length - 1, attemptIdx < 0 ? run.reviews.length - 1 : attemptIdx);
  const visualIdx = Math.min((run.visuals?.length ?? 1) - 1, attemptIdx < 0 ? (run.visuals?.length ?? 1) - 1 : attemptIdx);
  const clarifyQuestions = drawer === 'clarify' && run.clarify?.questions.length ? run.clarify : null;
  // Идущая попытка стадии, у которой результат появляется только в конце: вместо прошлой попытки — заглушка.
  const inProgress = Boolean(attempt?.status === 'running' && (drawer === 'tests' || drawer === 'review' || drawer === 'plan'));
  const slice: LogSlice | undefined =
    attempt && LOG_TITLE[drawer] && !clarifyQuestions
      ? { title: LOG_TITLE[drawer]!, attempt: attempt.attempt, stage: drawer, live: attempt.status === 'running' }
      : undefined;
  const visualAgent = run.agents.visual ?? 'claude';

  return (
    <div className={`details ${closing ? 'is-closing' : ''}`} key={drawer}>
      <header className="drawer-head">
        <span className={`drawer-icon st-${nodeState(run, drawer)}`}>{STAGE_ICON[drawer]}</span>
        <div className="drawer-title">
          <strong>{stageDef.title}</strong>
          <span>
            {drawer === 'visual' ? visualAgent : stageDef.role ? run.agents[stageDef.role] : stageDef.actor}
            {drawer === 'visual'
              ? attempt?.model && attempt.model !== visualAgent
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
            onChange={(v) => d.setAttemptNo(Number(v))}
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
        {inProgress && attempt && <InProgress stage={drawer} attempt={attempt} />}
        {showPlan && !inProgress && run.mode === 'bug' && run.repro && <ReproView run={run} kind="bug" />}
        {showPlan && !inProgress && (
          <PlanView docs={docs} run={run} comments={comments} onComments={onComments} editable={gate === 'gate1'} />
        )}
        {slice && attempt && <AgentOutput key={`${drawer}-${slice.attempt}`} runId={runId} slice={slice} attempt={attempt} />}
        {drawer === 'tests' && !inProgress && <TestsView run={run} idx={testIdx} />}
        {drawer === 'review' && !inProgress && (
          <ReviewView
            run={run}
            idx={reviewIdx}
            {...(gate === 'gate2' && reviewIdx === run.reviews.length - 1 ? { picked, onPicked } : {})}
          />
        )}
        {drawer === 'visual' && (
          <VisualView key={`visual-${attempt?.attempt ?? 0}`} run={run} runId={runId} attempt={attempt} idx={visualIdx} />
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
  );
}

/** proposal, tasks и design изменения: перечитываются при смене стадии прогона и при старте каждой стадии. */
function useChangeDocs(runId: string, enabled: boolean, stageKey: string): ChangeDocs | null {
  const [docs, setDocs] = useState<ChangeDocs | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () =>
      void bridge.core
        .getChangeDocs(runId)
        .then(setDocs)
        .catch(() => setDocs(null));
    refresh();
    return onCoreEvent((e) => {
      if (e.type === 'stage.started' && e.runId === runId) refresh();
    });
  }, [runId, enabled, stageKey]);
  return docs;
}
