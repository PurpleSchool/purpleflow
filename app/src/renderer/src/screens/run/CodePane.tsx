import { useEffect, useRef, useState } from 'react';
import { CircleAlert, FileCode2, RefreshCw } from 'lucide-react';
import type { DiffFile, RunFile } from '@psflow/core';
import { DiffReview } from '../../components/DiffReview';
import { Button, Empty } from '../../components/ui';
import { cleanErr } from './util';

/** Изменённые файлы прогона для счётчика на вкладке: пока прогон идёт — раз в несколько секунд, иначе на смене стадии. */
export function useChangedFiles(run: RunFile | undefined): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);
  /** Для какого прогона счётчик: при переходе на другой прогон старое число не показываем. */
  const loadedFor = useRef<string | undefined>(undefined);
  const id = run?.id;
  const live = run?.status === 'running';
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setFiles((f) => (f && id !== loadedFor.current ? null : f));
    loadedFor.current = id;
    const load = () => window.psflow.core.getChangedFiles(id).then((f) => alive && setFiles(f)).catch(() => {});
    void load();
    const timer = live ? setInterval(load, 8000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [id, live, run?.next, run?.attempts.length]);
  return files;
}

const time = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Вкладка «Код»: тот же просмотр диффа, что на приёмке, — в любой момент прогона, только для чтения.
 * Пока агент работает, дифф сам не перезагружается (не сбивает просмотр) — появляется «Обновить».
 */
export function CodePane({ run, changed }: { run: RunFile; changed: string[] | null }) {
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setDiff(await window.psflow.core.getDiff(run.id));
      setAt(new Date());
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setDiff(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  // Набор файлов изменился с последней загрузки — подсказываем обновить, а не перезагружаем под рукой.
  const loaded = diff?.map((f) => f.path).sort().join('\n');
  const now = changed ? [...changed].sort().join('\n') : loaded;
  const stale = Boolean(diff && changed && loaded !== now);
  const live = run.status === 'running';
  const lastReview = run.reviews.at(-1);

  return (
    <div className="pane pane-code">
      <div className="code-bar">
        <span className="code-count"><FileCode2 size={14} /> {diff ? `Изменено файлов: ${diff.length}` : 'Загружаю изменения…'}</span>
        {live && <span className="code-live">Агент работает — дифф может меняться</span>}
        {stale && <span className="code-stale">Есть новые изменения</span>}
        <span className="grow" />
        {at && <span className="code-at">обновлено в {time(at)}</span>}
        <Button tone={stale ? 'primary' : 'quiet'} icon={<RefreshCw size={14} />} busy={busy} onClick={() => void load()}>Обновить</Button>
      </div>
      {error ? <Empty icon={<CircleAlert />} title="Не удалось получить дифф">{error}</Empty>
        : !diff ? <div className="center"><span className="spinner big" /></div>
        : !diff.length ? <Empty icon={<FileCode2 />} title="Изменений пока нет">Агент ещё не менял файлы — загляните, когда пойдёт реализация.</Empty>
        : <DiffReview files={diff} review={lastReview} comments={[]} onComments={() => {}} readOnly groups={run.taskMap?.groups} />}
    </div>
  );
}
