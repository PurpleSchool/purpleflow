import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, FileCode2, RefreshCw } from 'lucide-react';
import type { DiffFile, LineComment, ReviewItem, RunFile } from '@purpleflow/core';
import { DiffReview } from '../../components/DiffReview';
import { PillTabs } from '../../components/PillTabs';
import { Button, Empty } from '../../components/ui';
import { bridge, cleanErr } from '../../lib/api';

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
    const load = () =>
      bridge.core
        .getChangedFiles(id)
        .then((f) => alive && setFiles(f))
        .catch(() => {});
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

/** Приёмка ждёт решения: замечания к строкам, выбор замечаний ревью, сводка «Что изменилось». */
export interface AcceptProps {
  picked: ReviewItem[];
  onPicked: (items: ReviewItem[]) => void;
  tab: 'code' | 'notes';
  onTab: (t: 'code' | 'notes') => void;
  comments: LineComment[];
  onComments: (c: LineComment[]) => void;
  notes: number;
  summary?: string | null;
  banner?: ReactNode;
}

/**
 * Вкладка «Код»: дифф прогона в любой момент. На приёмке — сама приёмка (замечания, выбор, сводка),
 * в остальное время — только просмотр. Дифф перезагружается на смене стадии; посреди работы агента —
 * подсказка «Есть новые изменения», чтобы не сбивать просмотр.
 */
export function CodePane({
  run,
  changed,
  accept,
  tools,
}: {
  run: RunFile;
  changed: string[] | null;
  accept?: AcceptProps;
  tools: HTMLElement | null;
}) {
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setDiff(await bridge.core.getDiff(run.id));
      setAt(new Date());
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setDiff(null);
  }, [run.id]);
  // Стадия сменилась (реализация закончилась, пришли на приёмку) — код уже другой, перезагружаем сами.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.next, run.attempts.length]);

  // Набор файлов изменился с последней загрузки — подсказываем обновить, а не перезагружаем под рукой.
  const loaded = diff
    ?.map((f) => f.path)
    .sort()
    .join('\n');
  const now = changed ? [...changed].sort().join('\n') : loaded;
  const stale = Boolean(diff && changed && loaded !== now);
  const live = run.status === 'running';
  const lastReview = run.reviews.at(-1);
  const lastVisual = run.visuals?.at(-1);

  // Переключатель и «Обновить» — в строке вкладок прогона, а не отдельной полосой над диффом.
  const bar = (
    <>
      {accept && diff && (
        <PillTabs<'code' | 'notes'>
          className="tabs attempts"
          value={accept.tab}
          onChange={accept.onTab}
          items={[
            { id: 'code', label: `Код · ${diff.length}` },
            {
              id: 'notes',
              label: `Заметки · ${accept.notes}`,
              extra: accept.picked.length ? <span className="tab-badge is-pick">{accept.picked.length}</span> : undefined,
            },
          ]}
        />
      )}
      {live && <span className="code-live">Агент работает — дифф может меняться</span>}
      {stale && <span className="code-stale">Есть новые изменения</span>}
      <span className="grow" />
      {at && <span className="code-at">обновлено в {time(at)}</span>}
      <Button tone={stale ? 'primary' : 'quiet'} icon={<RefreshCw size={14} />} busy={busy} onClick={() => void load()}>
        Обновить
      </Button>
    </>
  );

  return (
    <div className="pane pane-code">
      {tools && createPortal(bar, tools)}
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось получить дифф">
          {error}
        </Empty>
      ) : !diff ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : !diff.length ? (
        <Empty icon={<FileCode2 />} title="Изменений пока нет">
          Агент ещё не менял файлы — загляните, когда пойдёт реализация.
        </Empty>
      ) : (
        <>
          {accept?.banner}
          <DiffReview
            files={diff}
            viewedKey={run.id}
            review={lastReview}
            groups={run.taskMap?.groups}
            visualItems={lastVisual ? [...lastVisual.blocking, ...lastVisual.notes] : []}
            {...(accept
              ? {
                  comments: accept.comments,
                  onComments: accept.onComments,
                  picked: accept.picked,
                  onPicked: accept.onPicked,
                  tab: accept.tab,
                  onTab: accept.onTab,
                  summary: accept.summary,
                }
              : { comments: [], onComments: () => {}, readOnly: true })}
          />
        </>
      )}
    </div>
  );
}
