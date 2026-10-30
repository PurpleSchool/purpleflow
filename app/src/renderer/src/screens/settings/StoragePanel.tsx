// Место на диске: что занимают данные PurpleFlow и кэш приложения, очистка по категориям.
import type { StorageItem } from '@purpleflow/core';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { bridge } from '../../lib/api';

const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`
    : n >= 1024 ** 2
      ? `${Math.round(n / 1024 ** 2)} МБ`
      : n >= 1024
        ? `${Math.round(n / 1024)} КБ`
        : n > 0
          ? `${n} Б`
          : '—';
type Row = StorageItem;
/** Что PurpleFlow хранит в профиле пользователя и что из этого можно удалить. */
export function StoragePanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [freed, setFreed] = useState<{ id: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, cache] = await Promise.all([bridge.core.getStorage(), bridge.appCache.size()]);
      setRows([
        ...items,
        {
          id: 'app-cache',
          title: 'Кэш приложения',
          hint: 'Кэш Chromium: загруженные ресурсы, скомпилированный код, данные сайтов во вкладке «Браузер». Восстановится сам.',
          bytes: cache,
          count: 0,
          clean: 'Очистить',
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const clean = async (id: Row['id']) => {
    if (confirm !== id) return setConfirm(id);
    setConfirm(null);
    setBusy(id);
    setError(null);
    try {
      const before = rows?.find((r) => r.id === id)?.bytes ?? 0;
      let n: number;
      if (id === 'app-cache') {
        await bridge.appCache.clear();
        n = Math.max(0, before - (await bridge.appCache.size()));
      } else n = await bridge.core.cleanStorage(id);
      setFreed({ id, bytes: n });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const total = rows?.reduce((n, r) => n + r.bytes, 0) ?? 0;
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Хранилище{rows ? ` · ${bytes(total)}` : ''}</h2>
          <p>Что PurpleFlow хранит в профиле пользователя. Ваши проекты и ветки с результатами здесь не учитываются и не удаляются.</p>
        </div>
        <Button tone="quiet" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>
          Пересчитать
        </Button>
      </header>
      {error && <p className="inline-error">{error}</p>}
      {!rows ? (
        <div className="center storage-loading">
          <span className="spinner big" />
        </div>
      ) : (
        <div className="storage">
          {rows.map((r) => (
            <div key={r.id} className={`storage-row ${r.bytes ? '' : 'is-empty'}`}>
              <div className="storage-text">
                <strong>
                  {r.title}
                  {r.count ? <span className="muted"> · {r.count}</span> : null}
                </strong>
                <span>{r.hint}</span>
              </div>
              <span className="storage-size">{bytes(r.bytes)}</span>
              <div className="storage-action">
                {freed?.id === r.id && <span className="storage-freed">−{bytes(freed.bytes)}</span>}
                {r.clean && (
                  <Button
                    tone={confirm === r.id ? 'danger' : 'quiet'}
                    busy={busy === r.id}
                    disabled={!r.bytes || (busy !== null && busy !== r.id)}
                    onClick={() => void clean(r.id)}
                    onBlur={() => confirm === r.id && setTimeout(() => setConfirm(null), 150)}
                  >
                    {confirm === r.id ? 'Точно удалить?' : r.clean}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
