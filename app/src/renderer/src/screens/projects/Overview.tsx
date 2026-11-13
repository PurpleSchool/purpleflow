// Вкладка «Обзор»: ветка, origin, готовность к PR, статистика и прогоны проекта.
import type { ProjectKnowledge, ProjectOverview, ProjectStats } from '@purpleflow/core';
import { GitBranch, GitPullRequest, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { shortPath, tokens, when } from '../../lib/format';
import { MODES, stageTitle } from '../../lib/stages';
import { useStore, type ProjectTab } from '../../lib/store';
import { CmdChips, type LoadedProject, plural } from './common';
import { bridge } from '../../lib/api';

export function Overview({ p, onTab }: { p: LoadedProject; onTab: (t: ProjectTab) => void }) {
  const { state, go } = useStore();
  const [o, setO] = useState<ProjectOverview | null>(null);
  const [k, setK] = useState<ProjectKnowledge | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const repo = p.info.path;
  useEffect(() => {
    if (!p.info.isRepo) return;
    void bridge.core
      .projectOverview(repo)
      .then(setO)
      .catch(() => {});
    void bridge.core
      .getKnowledge(repo)
      .then(setK)
      .catch(() => {});
  }, [repo, p.info.isRepo]);
  const runs = state.runs.filter((r) => r.projectPath === repo);
  const sections = (k?.profile?.match(/^##\s/gm) ?? []).length;

  if (!p.info.isRepo) {
    return (
      <section className="panel knowledge-empty-card">
        <span className="browser-empty-icon">
          <TriangleAlert size={22} />
        </span>
        <strong>{p.info.repoRoot ? 'Папка внутри другого репозитория' : 'Это не git-репозиторий'}</strong>
        <p>
          {p.info.repoRoot ? (
            <>
              Папка лежит в репозитории <code>{p.info.repoRoot}</code> — задачи ушли бы в него. Выполните в папке <code>git init</code> или
              откройте корень репозитория.
            </>
          ) : (
            <>
              Выполните <code>git init</code> и первый коммит — прогоны работают в отдельных ветках.
            </>
          )}
        </p>
      </section>
    );
  }

  return (
    <>
      <div className="overview-grid">
        <section className="panel overview-card">
          <h3>Репозиторий</h3>
          <dl className="facts">
            <dt>Папка</dt>
            <dd>
              <span className="mono">{shortPath(repo)}</span>
              <button className="link" onClick={() => void bridge.openPath(repo)}>
                Открыть
              </button>
            </dd>
            <dt>Ветка</dt>
            <dd>
              {o ? (
                <>
                  <GitBranch size={13} /> <span className="mono">{o.branch ?? '—'}</span>
                  <span className="muted">{o.dirty ? ` · изменённых файлов: ${o.dirty}` : ' · без изменений'}</span>
                </>
              ) : (
                <span className="muted">…</span>
              )}
            </dd>
            <dt>origin</dt>
            <dd>
              {o ? (
                o.remote ? (
                  <span className="mono">{o.remote.replace(/^https?:\/\/|\.git$/g, '').replace(/^git@([^:]+):/, '$1/')}</span>
                ) : (
                  <span className="muted">не задан</span>
                )
              ) : (
                <span className="muted">…</span>
              )}
            </dd>
            <dt>Pull Request</dt>
            <dd>
              {o ? (
                o.prReady ? (
                  <span className="muted">{o.prReady}</span>
                ) : (
                  <>
                    <GitPullRequest size={13} className="ok" /> можно создавать через gh
                  </>
                )
              ) : (
                <span className="muted">…</span>
              )}
            </dd>
          </dl>
        </section>

        <section className="panel overview-card">
          <h3>Настройка</h3>
          <button className="overview-row" onClick={() => onTab('commands')}>
            <span className="overview-row-head">
              <strong>Команды и окружение</strong>
              {!p.cfg && <span className="tag is-wait">не сохранены</span>}
            </span>
            <span className="overview-chips">
              <CmdChips cmds={p.cmds} />
            </span>
          </button>
          <button className="overview-row" onClick={() => onTab('knowledge')}>
            <span className="overview-row-head">
              <strong>Знания о проекте</strong>
            </span>
            <span className="muted">
              {!k
                ? '…'
                : k.profile
                  ? `Профиль: ${sections || 1} ${plural(sections || 1, 'раздел', 'раздела', 'разделов')}, собран ${k.profileAt ? when(k.profileAt) : ''} · уроков: ${k.lessons?.length ?? 0}`
                  : 'Профиль ещё не собран — соберётся перед первым планом'}
            </span>
          </button>
        </section>
      </div>

      <StatsPanel repo={repo} runsKey={runs.map((r) => r.status + r.updatedAt).join()} />

      <section className="panel overview-runs">
        <header className="overview-runs-head">
          <h3>Прогоны</h3>
          <span className="muted">{runs.length || ''}</span>
        </header>
        {runs.length ? (
          <ul className="run-list">
            {runs.slice(0, 12).map((r) => (
              <li key={r.id}>
                <button className={`side-run st-${r.status}`} onClick={() => go({ name: 'run', runId: r.id })}>
                  <span className="side-dot" />
                  <span className="side-run-title">{r.title}</span>
                  <span className="run-list-mode">{MODES.find((m) => m.id === (r.mode ?? 'task'))?.title}</span>
                  <time className="muted">{when(r.createdAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Прогонов в этом проекте ещё не было.</p>
        )}
      </section>

      {p.cfg && (
        <div className="overview-forget">
          {forgetting ? (
            <>
              <span className="muted">Команды и знания проекта удалятся, прогоны останутся.</span>
              <Button tone="quiet" onClick={() => setForgetting(false)}>
                Отмена
              </Button>
              <Button tone="danger" onClick={() => void bridge.core.forgetProject(repo).then(() => go({ name: 'projects' }))}>
                Удалить настройки
              </Button>
            </>
          ) : (
            <Button tone="quiet" onClick={() => setForgetting(true)}>
              Удалить настройки проекта…
            </Button>
          )}
        </div>
      )}
    </>
  );
}
// ——— Статистика ———
function ms(n: number | null): string {
  if (n == null) return '—';
  const m = Math.round(n / 60_000);
  if (m < 1) return '< 1 мин';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
  return `${Math.floor(h / 24)} д${h % 24 ? ` ${h % 24} ч` : ''}`;
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
function StatsPanel({ repo, runsKey }: { repo: string; runsKey: string }) {
  const [s, setS] = useState<ProjectStats | null>(null);
  useEffect(() => {
    void bridge.core
      .projectStats(repo)
      .then(setS)
      .catch(() => setS(null));
  }, [repo, runsKey]);
  if (!s || s.total === 0) return null;

  const peak = Math.max(1, ...s.daily.map((d) => d.started));
  const returns = [
    { label: 'План вернули на доработку', n: s.returns.plan },
    { label: 'Замечания на приёмке', n: s.returns.acceptance },
    { label: 'Красные линтер или тесты', n: s.returns.tests },
    { label: 'Ревью нашло проблемы', n: s.returns.review },
    { label: 'Визуальная проверка нашла проблемы', n: s.returns.visual },
  ];
  const maxRet = Math.max(1, ...returns.map((r) => r.n));
  const time = s.agentMs + s.waitMs;
  const fmtDay = (d: string) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

  return (
    <section className="panel stats">
      <header className="overview-runs-head">
        <h3>Статистика</h3>
      </header>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Прогонов</span>
          <strong>{s.total}</strong>
          <span className="kpi-sub">
            готово {s.finished}
            {s.active ? ` · идут ${s.active}` : ''}
            {s.stopped ? ` · остановлено ${s.stopped}` : ''}
            {s.cancelled ? ` · отменено ${s.cancelled}` : ''}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Приняты с первого раза</span>
          <strong>{s.finished ? `${pct(s.firstPass, s.finished)}%` : '—'}</strong>
          <span className="kpi-sub">
            {s.finished ? `${s.firstPass} из ${s.finished} без возврата плана и результата` : 'пока нет готовых'}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">До готового коммита</span>
          <strong>{ms(s.medianLeadMs)}</strong>
          <span className="kpi-sub">медиана, вместе с ожиданием решений</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Попыток реализации</span>
          <strong>{s.avgImplAttempts == null ? '—' : s.avgImplAttempts.toFixed(1).replace('.', ',')}</strong>
          <span className="kpi-sub">в среднем на готовую задачу</span>
        </div>
      </div>

      <div className="activity">
        <div className="activity-head">
          <span className="kpi-label">Активность за 4 недели</span>
          <span className="activity-legend">
            <i className="is-started" />
            начато <i className="is-done" />
            готово
          </span>
        </div>
        <div className="activity-bars">
          {s.daily.map((d) => (
            <span key={d.day} className="activity-day" title={`${fmtDay(d.day)}: начато ${d.started}, готово ${d.finished}`}>
              <i className="is-started" style={{ height: `${(d.started / peak) * 100}%` }} />
              <i className="is-done" style={{ height: `${(Math.min(d.finished, peak) / peak) * 100}%` }} />
            </span>
          ))}
        </div>
        <div className="activity-axis">
          <span>{fmtDay(s.daily[0].day)}</span>
          <span>сегодня</span>
        </div>
      </div>

      <div className="stats-cols">
        <div className="stats-block">
          <span className="kpi-label">Возвраты</span>
          <ul className="hbars">
            {returns.map((r) => (
              <li key={r.label} className={r.n ? '' : 'is-zero'}>
                <span>{r.label}</span>
                <b>{r.n}</b>
                <i style={{ width: `${(r.n / maxRet) * 100}%` }} />
              </li>
            ))}
          </ul>
          {s.stops.length > 0 && (
            <p className="stats-note">
              Останавливались на: {s.stops.map((x) => `${stageTitle({ mode: 'task', visual: true }, x.stage)} — ${x.count}`).join(', ')}
            </p>
          )}
        </div>
        <div className="stats-block">
          <span className="kpi-label">Куда уходит время</span>
          {time > 0 ? (
            <>
              <div className="time-split">
                <i className="is-agent" style={{ width: `${pct(s.agentMs, time)}%` }} />
                <i className="is-wait" style={{ width: `${100 - pct(s.agentMs, time)}%` }} />
              </div>
              <div className="time-split-legend">
                <span>
                  <i className="is-agent" />
                  Агенты работают · {ms(s.agentMs)}
                </span>
                <span>
                  <i className="is-wait" />
                  Ждут вашего решения · {ms(s.waitMs)}
                </span>
              </div>
            </>
          ) : (
            <p className="stats-note">Нет данных</p>
          )}
          <span className="kpi-label stats-sub-head">По режимам</span>
          <div className="mode-stats">
            {s.byMode.map((m) => (
              <span key={m.mode} className="tag">
                {MODES.find((x) => x.id === m.mode)?.title ?? m.mode} · {m.total}
                {m.finished !== m.total ? ` (готово ${m.finished})` : ''}
              </span>
            ))}
          </div>
          <p className="stats-note">
            Токенов: {tokens(s.tokens)}
            {s.prs ? ` · PR: ${s.prs}` : ''}
            {s.merged ? ` · влито из приложения: ${s.merged}` : ''}
          </p>
        </div>
      </div>
    </section>
  );
}
