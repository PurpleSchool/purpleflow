// Стадия в работе: что сейчас делает агент и его вывод.
import type { StageAttempt, StageId } from '@purpleflow/core';
import { useEffect, useState } from 'react';
import { Markdown } from '../../../components/Markdown';
import { PillTabs } from '../../../components/PillTabs';
import { LiveLog, type LogSlice } from '../../../components/Terminal';
import { cut, finalMessage } from '../../../lib/logSlice';
import { bridge } from '../../../lib/api';

export const IN_PROGRESS: Partial<Record<StageId, { title: string; text: string }>> = {
  plan: { title: 'Планировщик пишет план', text: 'Документы изменения появятся, когда он закончит.' },
  tests: { title: 'Проверки идут', text: 'Линтер и тесты запущены — результат появится, когда они завершатся.' },
  review: { title: 'Идёт ревью', text: 'Ревьюер читает изменения — замечания появятся, когда он закончит.' },
};
export function InProgress({ stage, attempt }: { stage: StageId; attempt: StageAttempt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((now - Date.parse(attempt.startedAt)) / 1000));
  const c = IN_PROGRESS[stage] ?? { title: 'Выполняется', text: 'Результат появится, когда стадия завершится.' };
  return (
    <div className="in-progress">
      <span className="spinner big" />
      <h3>
        {c.title} · попытка #{attempt.attempt}
      </h3>
      <p>{c.text}</p>
      <small>{sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин ${String(sec % 60).padStart(2, '0')} с`}</small>
    </div>
  );
}
/** Стадия агента: итоговый ответ в Markdown отдельно от служебного лога. */
export function AgentOutput({ runId, slice, attempt }: { runId: string; slice: LogSlice; attempt: StageAttempt }) {
  const running = attempt.status === 'running';
  const [fromLog, setFromLog] = useState<string | null>(null);
  const [tab, setTab] = useState<'result' | 'log'>(running ? 'log' : 'result');
  useEffect(() => {
    if (running || attempt.output) return;
    let alive = true;
    bridge.core
      .getLog(runId)
      .then((full) => alive && setFromLog(finalMessage(cut(full, slice))))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- срез лога определяют название и номер попытки, объект slice новый на каждый рендер
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
        <div className="pane-log">
          <LiveLog runId={runId} slice={slice} />
        </div>
      )}
    </div>
  );
}
