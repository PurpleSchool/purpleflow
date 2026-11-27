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
  collapsible: collapsibleProp,
  minLevel = 0,
}: {
  items: PillItem<T>[];
  value: T | null;
  onChange: (id: T) => void;
  className?: string;
  itemClassName?: string;
  role?: string;
  /**
   * Не помещаются — подписи прячутся до иконок: сначала у всех, кроме выбранной, затем у всех.
   * По умолчанию — у вкладок с иконками.
   */
  collapsible?: boolean;
  /** Не шире этого уровня: 1 — подпись только у выбранной, даже если место есть. */
  minLevel?: 0 | 1 | 2;
}) {
  const collapsible = collapsibleProp ?? items.some((it) => it.icon);
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const [ind, setInd] = useState<{ x: number; w: number; ready: boolean }>({ x: 0, w: 0, ready: false });
  // 0 — подписи у всех; 1 — подпись только у выбранной; 2 — одни иконки.
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const compact = level > 0;
  // Невидимые копии вкладок на трёх уровнях, без анимации: по ним видно, какой уровень влезет.
  const measure = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const measureInd = () => {
      const el = value ? refs.current.get(value) : null;
      if (!el || !box.current) return setInd((s) => ({ ...s, w: 0 }));
      setInd((s) => ({ x: el.offsetLeft, w: el.offsetWidth, ready: s.ready || s.w > 0 }));
    };
    measureInd();
    // Подписи разъезжаются и съезжаются — подсветка следует за шириной вкладок.
    const ro = new ResizeObserver(measureInd);
    if (box.current) ro.observe(box.current);
    refs.current.forEach((el) => ro.observe(el));
    // Первое измерение — без анимации, дальше подсветка ездит.
    const t = requestAnimationFrame(() => setInd((s) => ({ ...s, ready: true })));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(t);
    };
  }, [value, items.length, level]);

  useLayoutEffect(() => {
    const el = box.current;
    const parent = el?.parentElement;
    if (!collapsible || !el || !parent) return;
    const fit = () => {
      // Сколько места у вкладок: ширина родителя без соседей (кнопки рядом) и зазоров.
      // Соседи в строке: обычные — своей шириной; растягивающиеся (.grow, панель инструментов) занимают
      // остаток, им оставляем только их min-width.
      const others = ([...parent.children] as HTMLElement[]).filter((c) => c !== el && getComputedStyle(c).position !== 'absolute');
      const taken = others.reduce((w, c) => {
        const cs = getComputedStyle(c);
        return w + (cs.flexGrow === '0' ? c.offsetWidth : parseFloat(cs.minWidth) || 0);
      }, 0);
      const ps = getComputedStyle(parent);
      const gap = parseFloat(ps.columnGap) || 0;
      const pad = (parseFloat(ps.paddingLeft) || 0) + (parseFloat(ps.paddingRight) || 0);
      const avail = parent.clientWidth - pad - taken - gap * others.length;
      const widths = [...(measure.current?.children ?? [])].map((c) => (c as HTMLElement).offsetWidth);
      const next = widths.findIndex((w) => w <= avail + 1);
      setLevel(Math.max(minLevel, next < 0 ? 2 : next) as 0 | 1 | 2);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [collapsible, value, items, minLevel]);

  return (
    <div ref={box} className={`pilltabs ${className} ${compact ? 'is-compact' : ''} ${level === 2 ? 'is-icons' : ''}`} role={role}>
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
          title={compact && (level === 2 || value !== it.id) && typeof it.label === 'string' ? it.label : undefined}
          aria-label={compact && typeof it.label === 'string' ? it.label : undefined}
        >
          {it.icon}
          {collapsible ? <span className="tab-label">{it.label}</span> : it.label}
          {it.extra}
        </button>
      ))}
      {collapsible && (
        <div ref={measure} className="pilltabs-measure" aria-hidden>
          {([0, 1, 2] as const).map((l) => (
            <div key={l} className={`pilltabs ${className} ${l > 0 ? 'is-compact' : ''} ${l === 2 ? 'is-icons' : ''}`}>
              {items.map((it) => (
                <button key={it.id} tabIndex={-1} className={`${itemClassName} ${value === it.id ? 'is-on' : ''}`}>
                  {it.icon}
                  <span className="tab-label">{it.label}</span>
                  {it.extra}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
