// Знаки поставщиков моделей картинок — встроенные SVG в цвете текста: без внешних картинок и лишних зависимостей.
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true };

/** Google — четырёхлучевая искра. */
function Google() {
  return (
    <svg {...base}>
      <path fill="currentColor" d="M12 2.5c.6 5.1 4.4 8.9 9.5 9.5-5.1.6-8.9 4.4-9.5 9.5-.6-5.1-4.4-8.9-9.5-9.5 5.1-.6 8.9-4.4 9.5-9.5Z" />
    </svg>
  );
}

/** Black Forest Labs — треугольник с внутренними гранями. */
function Bfl() {
  return (
    <svg {...base} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round">
      <path d="M12 4 21.5 19.5h-19Z" />
      <path d="M9.2 19.5 14.6 10.6M14 19.5l3-4.9" />
    </svg>
  );
}

/** OpenAI — переплетение из трёх лепестков. */
function OpenAi() {
  return (
    <svg {...base} fill="none" stroke="currentColor" strokeWidth={1.6}>
      {[0, 60, 120].map((a) => (
        <ellipse key={a} cx="12" cy="12" rx="8.4" ry="3.9" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

/** Qwen (Alibaba) — шестиконечник с гранями. */
function Qwen() {
  return (
    <svg {...base} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
      <path d="M12 2.8 16.6 7 21 12l-4.4 5L12 21.2 7.4 17 3 12l4.4-5Z" />
      <path d="M12 7.2 16.2 12 12 16.8 7.8 12Z" />
    </svg>
  );
}

const ICONS: Record<string, () => React.JSX.Element> = {
  Google,
  'Black Forest Labs': Bfl,
  OpenAI: OpenAi,
  Alibaba: Qwen,
};

/** Плитка со знаком поставщика; незнакомый — первая буква. */
export function VendorIcon({ vendor, size = 'm' }: { vendor: string; size?: 'xs' | 's' | 'm' }) {
  const Icon = ICONS[vendor];
  return (
    <span className={`vendor-icon is-${size}`} title={vendor}>
      {Icon ? <Icon /> : <b>{vendor.charAt(0)}</b>}
    </span>
  );
}
