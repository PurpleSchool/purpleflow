import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface DropOption<T extends string | number = string> {
  value: T;
  label: ReactNode;
  /** Вторая строка: путь, описание. */
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Позиция списка под полем (или над ним, если снизу не хватает места). Список — в портале: его не обрезают прокрутки. */
function usePopover(open: boolean, anchor: React.RefObject<HTMLElement | null>, minWidth?: number) {
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 12;
      const up = below < 220 && r.top > below;
      const width = Math.max(r.width, minWidth ?? 0);
      const left = Math.min(r.left, window.innerWidth - width - 8);
      setStyle(
        up
          ? { left, width, bottom: window.innerHeight - r.top + 6, maxHeight: Math.min(320, r.top - 12) }
          : { left, width, top: r.bottom + 6, maxHeight: Math.min(320, below) },
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, minWidth]);
  return style;
}

function useOutside(open: boolean, refs: React.RefObject<HTMLElement | null>[], close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, refs, close]);
}

function OptionList<T extends string | number>({
  options,
  value,
  active,
  setActive,
  pick,
  style,
  listRef,
  empty,
  mono,
}: {
  options: DropOption<T>[];
  value: T | undefined;
  active: number;
  setActive: (i: number) => void;
  pick: (o: DropOption<T>) => void;
  style: CSSProperties;
  listRef: React.RefObject<HTMLDivElement | null>;
  empty?: ReactNode;
  mono?: boolean;
}) {
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listRef]);
  return createPortal(
    <div className={`dd-pop ${mono ? 'is-mono' : ''}`} style={style} ref={listRef} role="listbox">
      {options.length === 0 && <div className="dd-empty">{empty ?? 'Ничего не найдено'}</div>}
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          role="option"
          data-i={i}
          aria-selected={o.value === value}
          disabled={o.disabled}
          className={`dd-opt ${i === active ? 'is-active' : ''} ${o.value === value ? 'is-on' : ''}`}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(o)}
        >
          {o.icon && <span className="dd-opt-icon">{o.icon}</span>}
          <span className="dd-opt-text">
            <span className="dd-opt-label">{o.label}</span>
            {o.hint && <span className="dd-opt-hint">{o.hint}</span>}
          </span>
          {o.value === value && <Check size={14} className="dd-opt-check" />}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** Выпадающий список в стиле приложения вместо системного select. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  placeholder = 'Выберите',
  icon,
  className = '',
  disabled,
  title,
  ariaLabel,
  minWidth,
  mono,
}: {
  value: T | undefined;
  options: DropOption<T>[];
  onChange: (v: T) => void;
  placeholder?: ReactNode;
  icon?: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  minWidth?: number;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const style = usePopover(open, btn, minWidth);
  useOutside(open, [btn, list], () => setOpen(false));
  const current = options.find((o) => o.value === value);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const show = () => {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };
  const pick = (o: DropOption<T>) => {
    setOpen(false);
    btn.current?.focus();
    if (o.value !== value) onChange(o.value);
  };
  const step = (d: number) => {
    const pos = enabled.indexOf(active);
    setActive(enabled[Math.min(enabled.length - 1, Math.max(0, (pos < 0 ? 0 : pos) + d))] ?? 0);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[active];
      if (o && !o.disabled) pick(o);
    } else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`dd ${open ? 'is-open' : ''} ${mono ? 'is-mono' : ''} ${className}`}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {icon && <span className="dd-icon">{icon}</span>}
        <span className={`dd-value ${current ? '' : 'is-placeholder'}`}>{current?.label ?? placeholder}</span>
        <ChevronDown size={14} className="dd-chev" />
      </button>
      {open && (
        <OptionList
          options={options}
          value={value}
          active={active}
          setActive={setActive}
          pick={pick}
          style={style}
          listRef={list}
          mono={mono}
        />
      )}
    </>
  );
}

/** Поле со списком подсказок: можно выбрать из списка или ввести своё (имя модели). */
export function ComboInput({
  value,
  options,
  onChange,
  onCommit,
  placeholder,
  className = '',
  disabled,
  ariaLabel,
  mono = true,
}: {
  value: string;
  options: DropOption<string>[];
  onChange: (v: string) => void;
  /** Значение окончательно выбрано: выбор из списка, Enter или уход с поля. */
  onCommit?: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const style = usePopover(open, wrap, 300);
  useOutside(open, [wrap, list], () => setOpen(false));
  // Пока человек не начал печатать — весь список; потом — подходящие.
  const q = value.trim().toLowerCase();
  const shown = typed && q ? options.filter((o) => String(o.value).toLowerCase().includes(q)) : options;

  const pick = (o: DropOption<string>) => {
    setOpen(false);
    setTyped(false);
    onChange(o.value);
    onCommit?.(o.value);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && shown[active]) pick(shown[active]);
      else {
        setOpen(false);
        onCommit?.(value);
        input.current?.blur();
      }
    } else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={wrap} className={`dd dd-combo ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}>
      <input
        ref={input}
        className={mono ? 'mono' : ''}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        aria-label={ariaLabel}
        onFocus={() => {
          setTyped(false);
          setActive(options.findIndex((o) => o.value === value));
          setOpen(true);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setActive(0);
          setOpen(true);
        }}
        onBlur={() => onCommit?.(value)}
        onKeyDown={onKey}
      />
      <button
        type="button"
        tabIndex={-1}
        className="dd-combo-btn"
        disabled={disabled}
        aria-label="Показать варианты"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else {
            setTyped(false);
            setOpen(true);
            input.current?.focus();
          }
        }}
      >
        <ChevronDown size={14} className="dd-chev" />
      </button>
      {open && shown.length > 0 && (
        <OptionList
          options={shown}
          value={value}
          active={active}
          setActive={setActive}
          pick={pick}
          style={style}
          listRef={list}
          mono={mono}
        />
      )}
    </div>
  );
}
