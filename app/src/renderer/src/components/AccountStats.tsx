import { useEffect, useMemo, useState } from 'react';
import { BarChart3, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import type { AccountKey, AccountOverview, AccountUsage, UsageBucket } from '../../../shared/ipc';
import { Button } from './ui';
import { Select } from './Dropdown';
import { useStore } from '../lib/store';

const PLANS_URL = 'https://purpleschool.ru/ai-for-code';

type PeriodId = 'week' | 'month' | 'quarter' | 'year';
const PERIODS: { id: PeriodId; label: string; bucket: UsageBucket }[] = [
  { id: 'week', label: 'Неделя', bucket: 'DAY' },
  { id: 'month', label: '30 дней', bucket: 'DAY' },
  { id: 'quarter', label: '3 месяца', bucket: 'WEEK' },
  { id: 'year', label: 'Год', bucket: 'MONTH' },
];

/** Цвета моделей в графике — сигналы из палитры приложения. */
const MODEL_COLORS = ['var(--accent)', 'var(--run)', 'var(--ok)', 'var(--wait)', 'var(--err)', 'var(--text-2)'];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcToday = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

/** Период в UTC, как его считает PurpleSchool: неделя — с понедельника по воскресенье. */
function periodRange(id: PeriodId): { from: string; to: string } {
  const today = utcToday();
  const from = new Date(today);
  const to = new Date(today);
  if (id === 'week') {
    from.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
    to.setTime(from.getTime());
    to.setUTCDate(from.getUTCDate() + 6);
  } else if (id === 'month') from.setUTCDate(today.getUTCDate() - 29);
  else if (id === 'quarter') {
    from.setUTCDate(today.getUTCDate() - 7 * 12 - ((today.getUTCDay() + 6) % 7));
  } else {
    from.setUTCMonth(today.getUTCMonth() - 11, 1);
  }
  return { from: iso(from), to: iso(to) };
}

const num = (v: string | number) => Number(v).toLocaleString('ru-RU');
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function bucketLabel(date: string, period: PeriodId): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (period === 'week') return WEEKDAYS[d.getUTCDay()];
  if (period === 'year') return MONTHS[d.getUTCMonth()];
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Заголовок подсказки: полная дата дня, неделя «с … по …» или месяц. */
function bucketTitle(date: string, period: PeriodId): string {
  const d = new Date(`${date}T00:00:00Z`);
  const fmt = (x: Date, o: Intl.DateTimeFormatOptions) => x.toLocaleDateString('ru-RU', { ...o, timeZone: 'UTC' });
  if (period === 'year') return fmt(d, { month: 'long', year: 'numeric' });
  if (period === 'quarter') {
    const end = new Date(d);
    end.setUTCDate(d.getUTCDate() + 6);
    return `${fmt(d, { day: 'numeric', month: 'short' })} — ${fmt(end, { day: 'numeric', month: 'short' })}`;
  }
  return fmt(d, { weekday: 'long', day: 'numeric', month: 'long' });
}

const dateRu = (s: string) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Баланс, план и расход AI-прокси — как в личном кабинете PurpleSchool. */
export function AccountStats({ onSignIn }: { onSignIn: () => void }) {
  const { state, reloadSettings } = useStore();
  const account = state.settings?.account;
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [keys, setKeys] = useState<AccountKey[]>([]);
  const [keyId, setKeyId] = useState<number | 0>(0);
  const [period, setPeriod] = useState<PeriodId>('week');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const fail = async (r: { error: string; code?: string }) => {
    setError(r.error);
    if (r.code === 'unauthorized') await reloadSettings();
  };

  const loadOverview = async () => {
    const [o, k] = await Promise.all([window.purpleflow.account.overview(), window.purpleflow.account.keys()]);
    if (!o.ok) return fail(o);
    setOverview(o.data);
    if (k.ok) setKeys(k.data.items);
  };

  const loadUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      const p = PERIODS.find((x) => x.id === period)!;
      const r = await window.purpleflow.account.usage({ ...periodRange(period), bucket: p.bucket, keyIds: keyId ? [keyId] : [] });
      if (!r.ok) return fail(r);
      setUsage(r.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (account) void loadOverview();
  }, [account?.email]);
  useEffect(() => {
    if (account) void loadUsage();
  }, [account?.email, period, keyId]);

  const models = useMemo(() => usage?.modelSummary.models.map((m) => m.modelName) ?? [], [usage]);
  const color = (name: string) => MODEL_COLORS[Math.max(0, models.indexOf(name)) % MODEL_COLORS.length];

  if (!account) {
    return (
      <section className="panel stats-empty">
        <span className="stats-empty-icon"><BarChart3 size={22} /></span>
        <h2>Статистика доступна с аккаунтом PurpleSchool</h2>
        <p>Войдите в аккаунт, и здесь появятся остаток токенов, тариф и расход по дням, ключам и моделям — как в личном кабинете.</p>
        <Button tone="primary" onClick={onSignIn}>Войти или зарегистрироваться</Button>
      </section>
    );
  }

  const b = overview?.balance;
  const plan = overview?.currentPlan;
  const buckets = usage?.timeSeries.buckets ?? [];
  const max = Math.max(1, ...buckets.map((x) => Number(x.totalUnitsSpend)));
  const total = Number(usage?.modelSummary.totalUnitsSpend ?? 0);
  const bucketWord = { DAY: 'в день', WEEK: 'в неделю', MONTH: 'в месяц', YEAR: 'в год' }[usage?.timeSeries.bucketType ?? 'DAY'];

  return (
    <>
      {error && <p className="auth-error stats-error" role="alert">{error}</p>}
      <div className="stats-top">
        <section className="panel stats-balance">
          <span className="stats-label">Суммарный остаток</span>
          <div className="stats-big">{b ? num(b.remainingUnits) : '—'} <span>токенов</span></div>
          {b && (
            <>
              <div className="stats-used">
                <span>Израсходовано из текущего баланса</span>
                <strong>{num(b.usedUnits)} из {num(b.totalInitialUnits)} · {b.usedPercentage}%</strong>
              </div>
              <div className="stats-bar"><i style={{ width: `${Math.min(100, 100 - b.usedPercentage)}%` }} /></div>
              {b.estimatedRemainingDays !== null && (
                <p className="stats-hint">При текущем расходе ({num(b.averageDailyUnitsSpend)} в день) хватит примерно на {num(b.estimatedRemainingDays)} дн.</p>
              )}
            </>
          )}
        </section>
        <section className="panel stats-plan">
          <span className="stats-label">Текущий план</span>
          {plan ? (
            <>
              <strong className="stats-plan-title">{plan.title}</strong>
              <p>{num(plan.unitsPerMonth)} токенов в месяц · {num(plan.priceMinor)} ₽</p>
              <p className="stats-hint">{plan.isAutoPaymentEnabled ? 'Следующее списание' : 'Действует до'} {dateRu(plan.nextPaymentAt)}</p>
            </>
          ) : overview ? (
            <>
              <strong className="stats-plan-title">Нет активной подписки</strong>
              <p className="stats-hint">Пакеты токенов можно использовать без подписки.</p>
            </>
          ) : <span className="spinner" />}
          <a className="btn btn-primary stats-plan-btn" href={PLANS_URL} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /><span>{plan ? 'Сменить тариф' : 'Выбрать подписку'}</span>
          </a>
        </section>
      </div>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Статистика использования</h2>
            <p>Расход токенов по дням, ключам и моделям. Даты — по UTC.</p>
          </div>
          <div className="panel-actions">
            <Select<number>
              className="stats-select"
              ariaLabel="Ключ"
              icon={<KeyRound size={14} />}
              value={keyId}
              minWidth={220}
              onChange={setKeyId}
              options={[{ value: 0, label: 'Все ключи' }, ...keys.map((k) => ({ value: k.id, label: k.name, hint: `…${k.tail}` }))]}
            />
            <div className="segmented small" role="radiogroup" aria-label="Период">
              {PERIODS.map((p) => (
                <button key={p.id} role="radio" aria-checked={period === p.id} className={period === p.id ? 'is-on' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>
              ))}
            </div>
            <Button tone="quiet" title="Обновить" icon={<RefreshCw size={14} />} busy={loading} onClick={() => { void loadOverview(); void loadUsage(); }} />
          </div>
        </header>
        <div className="stats-grid">
          <div className="stats-chart bezel">
            <h3>Расход по {period === 'year' ? 'месяцам' : period === 'quarter' ? 'неделям' : 'дням'}</h3>
            <div className={`stats-bars ${buckets.length > 14 ? 'is-dense' : ''}`}>
              {buckets.map((x, i) => {
                const v = Number(x.totalUnitsSpend);
                return (
                  <div
                    key={x.date}
                    className={`stats-col ${hover === i ? 'is-hover' : ''}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                  >
                    <div className="stats-bar-wrap">
                    {hover === i && (
                      <div className={`stats-tip ${i > buckets.length / 2 ? 'is-left' : ''}`} style={{ bottom: `calc(${(v / max) * 100}% + 8px)` }} role="tooltip">
                        <span className="stats-tip-date">{bucketTitle(x.date, period)}</span>
                        <strong>{num(v)} токенов</strong>
                        {x.modelUnitsSpend.map((m) => (
                          <span key={m.modelName} className="stats-tip-row">
                            <i style={{ background: color(m.modelName) }} />
                            <code>{m.modelName}</code>
                            <b>{num(m.unitsSpend)}</b>
                          </span>
                        ))}
                        {x.modelUnitsSpend.length > 0 && <span className="stats-tip-req">{num(x.modelUnitsSpend.reduce((n, m) => n + m.requestsCount, 0))} запросов</span>}
                      </div>
                    )}
                    <div className="stats-stack" style={{ height: `${(v / max) * 100}%` }}>
                      {x.modelUnitsSpend.map((m) => (
                        <i key={m.modelName} style={{ flexGrow: Number(m.unitsSpend), background: color(m.modelName) }} />
                      ))}
                    </div>
                    </div>
                    <span>{bucketLabel(x.date, period)}</span>
                  </div>
                );
              })}
            </div>
            {usage && total === 0 && <p className="stats-hint">За выбранный период расхода нет</p>}
          </div>
          <div className="stats-models bezel">
            <h3>По моделям</h3>
            {usage && usage.modelSummary.models.length === 0 && <p className="stats-hint">Нет расхода по моделям</p>}
            <div className="stats-model-list">
              {usage?.modelSummary.models.map((m) => (
                <div key={m.modelName} className="stats-model">
                  <div className="stats-model-head">
                    <span className="stats-dot" style={{ background: color(m.modelName) }} />
                    <code>{m.modelName}</code>
                    <span className="grow" />
                    <strong>{num(m.unitsSpend)}</strong>
                  </div>
                  <div className="stats-bar thin"><i style={{ width: `${total ? (Number(m.unitsSpend) / total) * 100 : 0}%`, background: color(m.modelName) }} /></div>
                  <span className="stats-hint">{num(m.requestsCount)} запросов</span>
                </div>
              ))}
            </div>
            <dl className="stats-totals">
              <div><dt>Всего за период</dt><dd>{num(usage?.modelSummary.totalUnitsSpend ?? 0)} токенов</dd></div>
              <div><dt>Запросов</dt><dd>{num(usage?.modelSummary.totalRequests ?? 0)}</dd></div>
              <div><dt>В среднем {bucketWord}</dt><dd>{num(usage?.modelSummary.averageUnitsSpendPerBucket ?? 0)} токенов</dd></div>
            </dl>
          </div>
        </div>
      </section>
    </>
  );
}
