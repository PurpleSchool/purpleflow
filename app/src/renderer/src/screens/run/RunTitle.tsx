// Шапка прогона: название и описание задачи, режим, ветка, метрики и действия — продолжить, следующая часть, стоп.
import type { RunFile, StageId } from '@purpleflow/core';
import { ArrowRight, ChevronDown, CircleStop, FileText, FolderOpen, GitBranch, Paperclip, Play, SkipForward } from 'lucide-react';
import { useState } from 'react';
import { MODE_ICON } from '../../components/ModeIcon';
import { Button, StatusPill } from '../../components/ui';
import { bridge } from '../../lib/api';
import { shortPath } from '../../lib/format';
import { MODES } from '../../lib/stages';
import { useStore } from '../../lib/store';
import { Attachments, DeleteRun, MergeControl, MetricsInline } from './RunHeader';

export function RunTitle({
  run,
  runId,
  gate,
  busy,
  act,
}: {
  run: RunFile;
  runId: string;
  gate: StageId | null;
  busy: string | null;
  /** Действие с индикатором на кнопке name и ошибкой внизу экрана. */
  act: (name: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { go } = useStore();
  const [descOpen, setDescOpen] = useState(false);
  const dispatch = bridge.core.dispatch;
  const live = run.status === 'running' || run.status === 'waiting';
  const resumable = run.status === 'stopped';
  // Реализация уже хоть раз завершилась, а прогон крутится между ней и проверками — можно не ждать зелёных тестов.
  const canSkipChecks =
    (live || resumable) &&
    (run.next === 'implement' || run.next === 'tests') &&
    run.attempts.some((a) => a.stage === 'implement' && a.status === 'done');

  return (
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
            {MODE_ICON[run.mode]} {MODES.find((m) => m.id === run.mode)?.title}
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
          onClick={() => void bridge.openPath(run.worktreePath)}
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
                const d = await bridge.core.nextPartDraft(runId);
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
  );
}
