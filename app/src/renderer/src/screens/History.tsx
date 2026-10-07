import { useEffect } from 'react';
import { Inbox } from 'lucide-react';
import { Button, Empty, StatusPill, Topbar } from '../components/ui';
import { useStore } from '../lib/store';
import { MODES, stagesFor, type Mode } from '../lib/stages';
import { cost, shortPath, tokens, usageTotal, when } from '../lib/format';

export function HistoryScreen() {
  const { state, go, refreshRuns } = useStore();
  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);
  const runs = state.runs;
  const finished = runs.filter((r) => r.status === 'finished');
  const allTokens = runs.reduce((n, r) => n + usageTotal(r.totals), 0);

  return (
    <div className="screen">
      <Topbar
        title="История"
        sub={runs.length ? `${runs.length} прогонов · доведено до коммита ${finished.length} · ${tokens(allTokens)} токенов` : 'Прогоны из run.json'}
      />
      <div className="scroll">
        {runs.length === 0 ? (
          <Empty icon={<Inbox />} title="Прогонов пока нет" action={<Button tone="primary" onClick={() => go({ name: 'new' })}>Новая задача</Button>}>
            Каждый прогон сохраняет стадии, попытки, решения на гейтах и токены в run.json своего изменения.
          </Empty>
        ) : (
          <table className="history">
            <thead>
              <tr>
                <th>Задача</th>
                <th>Статус</th>
                <th>Где остановился</th>
                <th className="num">Попытки</th>
                <th className="num">Токены</th>
                <th>Начат</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} onClick={() => !r.missing && go({ name: 'run', runId: r.id })} className={r.missing ? 'is-missing' : ''}>
                  <td>
                    <div className="h-title">{r.title}</div>
                    <div className="h-sub mono">{r.missing ? shortPath(r.runJsonPath) : `${shortPath(r.projectPath)} · ${r.branch}`}</div>
                  </td>
                  <td><StatusPill status={r.status} /></td>
                  <td className="muted">{r.status === 'finished' ? '—' : r.next === 'limit' ? 'Нужно решение' : stagesFor((r.mode ?? 'task') as Mode, true).find((s) => s.id === r.next)?.title}</td>
                  <td className="num">{r.implAttemptsUsed}</td>
                  <td className="num">{usageTotal(r.totals) ? tokens(usageTotal(r.totals)) : '—'}{cost(r.totals) && <small className="muted"> {cost(r.totals)}</small>}</td>
                  <td className="muted">{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
