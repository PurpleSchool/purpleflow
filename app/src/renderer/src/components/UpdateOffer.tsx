import { useEffect, useState } from 'react';
import { CircleCheck, Download, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import { RELEASES_URL, type UpdateState } from '../../../shared/update';
import { bridge } from '../lib/api';
import { Button } from './ui';

/** Предложение обновиться. Сам ничего не ставит: перезапуск прервёт идущие прогоны, решает пользователь. */
export function UpdateOffer() {
  const [s, setS] = useState<UpdateState>({ kind: 'idle' });
  const [hidden, setHidden] = useState<string | null>(null);
  const [running, setRunning] = useState<number | null>(null);

  useEffect(() => {
    void bridge.update.state().then(setS);
    const offState = bridge.update.onState(setS);
    const offReveal = bridge.update.onReveal(() => setHidden(null));
    return () => {
      offState();
      offReveal();
    };
  }, []);

  if (s.kind === 'idle') return null;
  // Отложить можно каждый шаг отдельно: сбой после «Позже» на предложении всё равно должен быть виден.
  const key = `${s.kind}:${'version' in s ? s.version : ''}`;
  if (hidden === key) return null;
  const later = (label = 'Позже') => (
    <Button tone="quiet" onClick={() => setHidden(key)}>
      {label}
    </Button>
  );

  const restart = async () => {
    if (running === null) {
      const runs = await bridge.core.listRuns();
      const active = runs.filter((r) => r.status === 'running').length;
      if (active > 0) {
        setRunning(active);
        return;
      }
    }
    await bridge.update.install();
  };

  return (
    <aside className="update-offer" role="status" aria-label="Обновление">
      {s.kind === 'checking' && (
        <p>
          <LoaderCircle size={15} className="spin" /> Проверяю обновления…
        </p>
      )}
      {s.kind === 'latest' && (
        <>
          <p>
            <CircleCheck size={15} /> У вас последняя версия: {s.version}
          </p>
          <div className="update-offer-actions">{later('Закрыть')}</div>
        </>
      )}
      {s.kind === 'check-failed' && (
        <>
          <p>
            <TriangleAlert size={15} /> Не удалось проверить обновления
          </p>
          <p className="update-offer-note">{s.message}</p>
          <div className="update-offer-actions">{later('Закрыть')}</div>
        </>
      )}
      {s.kind === 'available' && (
        <>
          <p>
            <Download size={15} /> Доступна версия {s.version}
          </p>
          <div className="update-offer-actions">
            {later()}
            <Button tone="primary" onClick={() => void bridge.update.download()}>
              Обновить
            </Button>
          </div>
        </>
      )}
      {s.kind === 'downloading' && (
        <>
          <p>
            <Download size={15} /> Скачиваю версию {s.version} — {s.percent}%
          </p>
          <div className="update-offer-actions">{later('Скрыть')}</div>
        </>
      )}
      {s.kind === 'ready' && (
        <>
          <p>
            <RotateCw size={15} /> Версия {s.version} готова к установке
          </p>
          {running !== null && (
            <p className="update-offer-note">Идёт прогонов: {running}. Они остановятся, после запуска их можно продолжить.</p>
          )}
          <div className="update-offer-actions">
            {later()}
            <Button tone="primary" onClick={() => void restart()}>
              {running === null ? 'Перезапустить' : 'Всё равно перезапустить'}
            </Button>
          </div>
        </>
      )}
      {s.kind === 'failed' && (
        <>
          <p>
            <TriangleAlert size={15} /> Не удалось обновиться до версии {s.version}
          </p>
          <p className="update-offer-note">{s.message}</p>
          <div className="update-offer-actions">
            {later('Закрыть')}
            <a className="btn btn-primary" href={RELEASES_URL} target="_blank" rel="noreferrer">
              Скачать вручную
            </a>
          </div>
        </>
      )}
    </aside>
  );
}
