import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleCheck, Download, LoaderCircle, RotateCw, Sparkles, TriangleAlert, X } from 'lucide-react';
import { RELEASES_URL, type UpdateState } from '../../../shared/update';
import { releasesBetween, shouldShowWhatsNew, type Release } from '../../../shared/releases';
import { bridge, cleanErr } from '../lib/api';
import { closeWhatsNew, openWhatsNew, restartForUpdate, useUpdateState, useWhatsNewOpen } from '../lib/update';
import { Markdown } from './Markdown';
import { Button } from './ui';

/** Есть что сделать с обновлением: боковая панель показывает кнопку, а не только пункт меню. */
export const updatePending = (s: UpdateState) => s.kind === 'available' || s.kind === 'downloading' || s.kind === 'ready';

/** Кнопка шага обновления: скачать, ход загрузки, перезапуск. Решает пользователь — сами ничего не ставим. */
export function UpdateButton({ s, compact }: { s: UpdateState; compact?: boolean }) {
  const [running, setRunning] = useState<number | null>(null);
  const [error, setError] = useState('');
  if (s.kind === 'available' || s.kind === 'failed')
    return (
      <Button tone="primary" icon={<Download size={14} />} onClick={() => void bridge.update.download()}>
        {s.kind === 'failed' ? 'Ещё раз' : 'Обновить'}
      </Button>
    );
  if (s.kind === 'downloading')
    return (
      <Button tone="quiet" disabled icon={<LoaderCircle size={14} className="spin" />}>
        {s.percent}%
      </Button>
    );
  if (s.kind !== 'ready') return null;
  return (
    <>
      {running !== null && !compact && (
        <span className="wn-note">Идёт прогонов: {running}. Они остановятся, после запуска их можно продолжить.</span>
      )}
      {error && (
        <span role="alert" className="wn-note">
          {error}
        </span>
      )}
      <Button
        tone="primary"
        icon={<RotateCw size={14} />}
        title={running !== null ? `Идёт прогонов: ${running} — они остановятся` : undefined}
        onClick={() => {
          setError('');
          void restartForUpdate(running !== null)
            .then((r) => r && setRunning(r.running))
            .catch((error: unknown) => setError(cleanErr(error)));
        }}
      >
        {running === null ? 'Перезапустить' : 'Всё равно перезапустить'}
      </Button>
    </>
  );
}

/** Строка состояния обновления наверху окна «Что нового». */
function UpdateStatus({ s }: { s: UpdateState }) {
  if (s.kind === 'idle') return null;
  const line = (icon: ReactNode, text: string, note?: string) => (
    <div className={`wn-update is-${s.kind}`} role="status" aria-label="Обновление">
      <p>
        {icon} {text}
      </p>
      {note && <p className="wn-note">{note}</p>}
      <div className="wn-update-actions">
        <UpdateButton s={s} />
        {s.kind === 'failed' && (
          <a className="btn btn-quiet" href={RELEASES_URL} target="_blank" rel="noreferrer">
            Скачать вручную
          </a>
        )}
      </div>
    </div>
  );
  switch (s.kind) {
    case 'checking':
      return line(<LoaderCircle size={15} className="spin" />, 'Проверяю обновления…');
    case 'latest':
      return line(<CircleCheck size={15} />, `У вас последняя версия: ${s.version}`);
    case 'check-failed':
      return line(<TriangleAlert size={15} />, 'Не удалось проверить обновления', s.message);
    case 'available':
      return line(<Download size={15} />, `Доступна версия ${s.version}`);
    case 'downloading':
      return line(<Download size={15} />, `Скачиваю версию ${s.version}`);
    case 'ready':
      return line(<RotateCw size={15} />, `Версия ${s.version} готова к установке`);
    case 'failed':
      return line(<TriangleAlert size={15} />, `Не удалось обновиться до версии ${s.version}`, s.message);
  }
}

const dateText = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Окно «Что нового»: выпуски с GitHub и состояние обновления. После обновления открывается само
 * и выделяет выпуски, которых пользователь ещё не видел.
 */
export function WhatsNewHost() {
  const open = useWhatsNewOpen();
  const s = useUpdateState();
  const [versions, setVersions] = useState<{ current: string; seen: string } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [data, setData] = useState<{ releases: Release[]; error?: string } | null>(null);

  useEffect(() => {
    void bridge.whatsNew.versions().then((v) => {
      setVersions(v);
      if (shouldShowWhatsNew(v.seen, v.current)) {
        setFresh(v.seen);
        openWhatsNew();
      }
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    void bridge.whatsNew.releases().then(setData);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    closeWhatsNew();
    if (fresh !== null) {
      setFresh(null);
      void bridge.whatsNew.seen();
    }
  };

  if (!open) return null;
  const current = versions?.current ?? '';
  const list = data?.releases ?? [];
  const isNew = new Set(fresh !== null && current ? releasesBetween(list, fresh, current).map((r) => r.version) : []);

  return createPortal(
    <div className="qs-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="qs wn" role="dialog" aria-modal aria-labelledby="wn-title">
        <header className="qs-head">
          <div>
            <h2 id="wn-title">{fresh !== null ? `Обновились до ${current}` : 'Что нового'}</h2>
            <p>{fresh !== null ? 'Вот что появилось с прошлой версии.' : `Ваша версия — ${current || '…'}. Изменения по выпускам.`}</p>
          </div>
          <button className="qs-close" aria-label="Закрыть" onClick={close}>
            <X size={16} />
          </button>
        </header>

        <UpdateStatus s={s} />

        <div className="wn-list">
          {!data && (
            <p className="wn-empty">
              <LoaderCircle size={15} className="spin" /> Загружаю список изменений…
            </p>
          )}
          {data && list.length === 0 && (
            <p className="wn-empty">
              Не удалось загрузить список изменений{data.error ? `: ${data.error}` : ''}.{' '}
              <a href={RELEASES_URL.replace(/\/latest$/, '')} target="_blank" rel="noreferrer">
                Открыть на GitHub
              </a>
            </p>
          )}
          {list.map((r) => (
            <article key={r.version} className={`wn-release ${isNew.has(r.version) ? 'is-new' : ''}`} aria-label={`Версия ${r.version}`}>
              <header>
                <strong>{r.version}</strong>
                {r.version === current && <span className="wn-tag">ваша версия</span>}
                {isNew.has(r.version) && (
                  <span className="wn-tag is-new">
                    <Sparkles size={11} /> новое
                  </span>
                )}
                <span className="grow" />
                <time dateTime={r.date}>{dateText(r.date)}</time>
              </header>
              {r.notes ? <Markdown source={r.notes} className="wn-notes" /> : <p className="wn-empty">Без описания.</p>}
            </article>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
