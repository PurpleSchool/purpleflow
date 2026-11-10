import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface PillItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Иконка слева от подписи. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Дополнение справа от подписи: бейдж, точка статуса. */
  extra?: ReactNode;
}

/**
 * Пилюли-вкладки: подсветка активной не прыгает, а переезжает к выбранной —
 * так видно, откуда и куда переключился раздел.
 */
export function PillTabs<T extends string>({
  items,
  value,
  onChange,
  className = '',
  itemClassName = 'tab',
  role = 'tablist',
}: {
  items: PillItem<T>[];
  value: T | null;
  onChange: (id: T) => void;
  className?: string;
  itemClassName?: string;
  role?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const [ind, setInd] = useState<{ x: number; w: number; ready: boolean }>({ x: 0, w: 0, ready: false });

  useLayoutEffect(() => {
    const measure = () => {
      const el = value ? refs.current.get(value) : null;
      if (!el || !box.current) return setInd((s) => ({ ...s, w: 0 }));
      setInd((s) => ({ x: el.offsetLeft, w: el.offsetWidth, ready: s.ready || s.w > 0 }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    refs.current.forEach((el) => ro.observe(el));
    // Первое измерение — без анимации, дальше подсветка ездит.
    const t = requestAnimationFrame(() => setInd((s) => ({ ...s, ready: true })));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(t);
    };
  }, [value, items.length]);

  return (
    <div ref={box} className={`pilltabs ${className}`} role={role}>
      <span
        className={`pill-indicator ${ind.ready ? 'is-ready' : ''}`}
        style={{ transform: `translateX(${ind.x}px)`, width: ind.w, opacity: ind.w ? 1 : 0 }}
        aria-hidden
      />
      {items.map((it) => (
        <button
          key={it.id}
          ref={(el) => {
            if (el) refs.current.set(it.id, el);
            else refs.current.delete(it.id);
          }}
          role={role === 'tablist' ? 'tab' : undefined}
          aria-selected={role === 'tablist' ? value === it.id : undefined}
          className={`${itemClassName} ${value === it.id ? 'is-on' : ''}`}
          disabled={it.disabled}
          onClick={() => onChange(it.id)}
        >
          {it.icon}
          {it.label}
          {it.extra}
        </button>
      ))}
    </div>
  );
}
