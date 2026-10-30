// Ревью другой моделью: блокирующие замечания и заметки.
import type { ReviewItem, RunFile } from '@purpleflow/core';
import { CircleCheck, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { OriginTag, PickBox } from '../../../components/diff/ReviewNotes';
import { Empty } from '../../../components/ui';
import { originSummary } from '../util';

export function ReviewView({
  run,
  idx,
  picked,
  onPicked,
}: {
  run: RunFile;
  idx: number;
  picked?: ReviewItem[];
  onPicked?: (items: ReviewItem[]) => void;
}) {
  const r = run.reviews[idx];
  const items = useMemo(
    () =>
      r ? [...r.blocking.map((x) => ({ ...x, kind: 'blocking' as const })), ...r.notes.map((x) => ({ ...x, kind: 'note' as const }))] : [],
    [r],
  );
  if (!r) return <Empty icon={<Sparkles />} title="Ревью ещё не было" />;
  return (
    <div className="scroll">
      <div className="review">
        <div className={`verdict bezel ${r.blocking.length ? 'is-bad' : 'is-ok'}`}>
          <span className="verdict-mark">{r.blocking.length ? r.blocking.length : <CircleCheck size={22} />}</span>
          <div>
            <strong>{r.blocking.length ? `Блокирующих замечаний: ${r.blocking.length}` : 'Блокирующих замечаний нет'}</strong>
            <p>
              {r.blocking.length
                ? run.next === 'limit' && idx === run.reviews.length - 1
                  ? 'Попытки реализации исчерпаны — решение за вами: ещё попытка или дальше как есть.'
                  : 'Задача вернулась исполнителю с этими замечаниями.'
                : 'Изменение передано вам на приёмку.'}{' '}
              Заметок: {r.notes.length}.{originSummary(r.blocking)}
            </p>
          </div>
          <span className="muted mono">
            {run.agents.reviewer} · {run.models.reviewer || 'по умолчанию'}
          </span>
        </div>
        <ul className="review-list">
          {items.map((x, i) => (
            <li key={i} className={`note n-${x.kind}`}>
              {x.file && (
                <span className="note-loc">
                  {x.file}
                  {x.line ? `:${x.line}` : ''}
                </span>
              )}
              <OriginTag origin={x.origin} />
              <p>{x.message}</p>
              {picked && onPicked && <PickBox item={x} picked={picked} onPicked={onPicked} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
