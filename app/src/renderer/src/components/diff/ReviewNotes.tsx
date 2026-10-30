// Замечания ревью рядом с диффом: список, пометки повторного ревью, выбор пунктов.
import type { ReviewItem } from '@purpleflow/core';

export const reviewKey = (r: ReviewItem) => `${r.file ?? ''}:${r.line ?? ''}:${r.message}`;
/** Галочка «исправить» у замечания ревьюера. */
export function PickBox({ item, picked, onPicked }: { item: ReviewItem; picked: ReviewItem[]; onPicked: (items: ReviewItem[]) => void }) {
  const on = picked.some((x) => reviewKey(x) === reviewKey(item));
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch pick-switch ${on ? 'is-on' : ''}`}
      title={on ? 'Убрать из исправлений' : 'Отдать исполнителю на исправление'}
      onClick={() => onPicked(on ? picked.filter((x) => reviewKey(x) !== reviewKey(item)) : [...picked, item])}
    >
      <i />
      <span>Исправить</span>
    </button>
  );
}
const ORIGIN: Record<NonNullable<ReviewItem['origin']>, { label: string; title: string }> = {
  unfixed: { label: 'не исправлено', title: 'Это замечание было и на прошлом ревью — исполнитель его не исправил или обошёл' },
  from_fix: { label: 'из‑за исправления', title: 'Появилось в коде, который исполнитель поменял, исправляя прошлые замечания' },
  new: { label: 'новое', title: 'В коде, который был и на прошлом ревью, — ревьюер заметил только сейчас' },
};
/** Пометка повторного ревью: ходит ли прогон по кругу. */
export function OriginTag({ origin }: { origin?: ReviewItem['origin'] }) {
  if (!origin) return null;
  return (
    <span className={`origin-tag o-${origin}`} title={ORIGIN[origin].title}>
      {ORIGIN[origin].label}
    </span>
  );
}
export function NoteList({
  title,
  kind,
  items,
  onJump,
  picked,
  onPicked,
}: {
  title: string;
  kind: 'blocking' | 'note';
  items: ReviewItem[];
  onJump: (r: ReviewItem) => void;
  picked?: ReviewItem[];
  onPicked?: (items: ReviewItem[]) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="notes">
      <h4>
        {title} <span className="muted">{items.length}</span>
      </h4>
      {items.map((r, i) => (
        <div key={i} className={`note n-${kind}`}>
          {r.file && (
            <button className="note-loc" onClick={() => onJump(r)}>
              {r.file.split('/').pop()}
              {r.line ? `:${r.line}` : ''}
            </button>
          )}
          <OriginTag origin={r.origin} />
          <p>{r.message}</p>
          {picked && onPicked && <PickBox item={r} picked={picked} onPicked={onPicked} />}
        </div>
      ))}
    </section>
  );
}
