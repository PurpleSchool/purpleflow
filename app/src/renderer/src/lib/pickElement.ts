// «Указать элемент» во вкладке «Браузер»: подсветка под курсором, клик — описание элемента для чата.

export interface PickedElement {
  url: string;
  tag: string;
  id?: string;
  classes?: string[];
  /** Видимый текст элемента, коротко. */
  text?: string;
  selector: string;
  /** Компоненты React или Vue от ближайшего наружу. */
  components?: string[];
  /** Файл компонента, если сборка его сообщает (dev-сборки React до 19 и Vue). */
  source?: string;
  attrs?: Record<string, string>;
  width: number;
  height: number;
}

/**
 * Скрипт для webview: возвращает Promise с описанием выбранного элемента или null (Escape, отмена).
 * Клики по странице, пока идёт выбор, до неё не доходят — кнопки и ссылки не срабатывают.
 */
export const PICK_SCRIPT = `(() => new Promise((resolve) => {
  if (window.__pfPick) window.__pfPick.cancel();
  const ACCENT = '#8a74ee';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid ' + ACCENT + ';background:rgba(138,116,238,0.14);border-radius:4px;display:none;box-sizing:border-box';
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:' + ACCENT + ';color:#fff;font:600 11px/1.4 ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis';
  const cursor = document.createElement('style');
  cursor.textContent = '*{cursor:crosshair!important}';
  document.documentElement.append(box, tip, cursor);
  let cur = null;

  const cssId = (s) => /^[A-Za-z_][\\w-]*$/.test(s);
  const short = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id && cssId(el.id)) return s + '#' + el.id;
    const cls = [...el.classList].filter(cssId).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const selector = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && parts.length < 5; n = n.parentElement) {
      let s = short(n);
      if (n.id && cssId(n.id)) { parts.unshift(s); break; }
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const components = (el) => {
    const names = [];
    let source;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? el[key] : null; f && names.length < 4; f = f.return) {
      const t = f.type;
      const name = typeof t === 'function' ? t.displayName || t.name : t && typeof t === 'object' ? t.displayName || (t.render && (t.render.displayName || t.render.name)) : null;
      if (name && /^[A-Z]/.test(name) && !names.includes(name)) names.push(name);
      if (!source && f._debugSource) source = f._debugSource.fileName + ':' + f._debugSource.lineNumber;
    }
    for (let n = el; n && !names.length; n = n.parentElement) {
      let c = n.__vueParentComponent;
      while (c && names.length < 4) {
        const name = c.type && (c.type.name || c.type.__name);
        if (name && !names.includes(name)) names.push(name);
        if (!source && c.type && c.type.__file) source = c.type.__file;
        c = c.parent;
      }
    }
    return { names, source };
  };
  const ATTRS = ['href', 'src', 'alt', 'placeholder', 'aria-label', 'role', 'name', 'type', 'data-testid'];
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) attrs[a] = v.length > 160 ? v.slice(0, 160) + '…' : v;
    }
    const raw = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    const c = components(el);
    return {
      url: location.href,
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: [...el.classList].slice(0, 6),
      text: raw ? (raw.length > 160 ? raw.slice(0, 160) + '…' : raw) : undefined,
      selector: selector(el),
      components: c.names.length ? c.names : undefined,
      source: c.source,
      attrs: Object.keys(attrs).length ? attrs : undefined,
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };

  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip) return;
    cur = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const c = components(el).names[0];
    tip.textContent = (c ? c + ' · ' : '') + short(el) + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
    Object.assign(tip.style, { display: 'block', left: Math.max(4, r.left) + 'px', top: (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px' });
  };
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const click = (e) => {
    swallow(e);
    const el = cur || document.elementFromPoint(e.clientX, e.clientY);
    done(el ? describe(el) : null);
  };
  const key = (e) => { if (e.key === 'Escape') { swallow(e); done(null); } };
  const BLOCK = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];
  const done = (v) => {
    removeEventListener('mousemove', move, true);
    removeEventListener('click', click, true);
    removeEventListener('keydown', key, true);
    for (const t of BLOCK) removeEventListener(t, swallow, true);
    box.remove(); tip.remove(); cursor.remove();
    delete window.__pfPick;
    resolve(v);
  };
  window.__pfPick = { cancel: () => done(null) };
  addEventListener('mousemove', move, true);
  addEventListener('click', click, true);
  addEventListener('keydown', key, true);
  for (const t of BLOCK) addEventListener(t, swallow, true);
}))()`;

export const CANCEL_PICK_SCRIPT = 'window.__pfPick && window.__pfPick.cancel()';

const ATTR_LABEL: Record<string, string> = {
  href: 'ссылка',
  src: 'src',
  alt: 'alt',
  placeholder: 'placeholder',
  'aria-label': 'aria-label',
  role: 'role',
  name: 'name',
  type: 'type',
  'data-testid': 'data-testid',
};

/** Адрес без протокола и хвостового «/» у корня: localhost:3000/pricing. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^([^/]+)\/$/, '$1');
}

/** Описание элемента для поля ввода чата: агент поймёт, о чём речь, и найдёт его в коде. */
export function formatPick(p: PickedElement): string {
  const head = `<${p.tag}${p.id ? `#${p.id}` : ''}${p.classes?.length ? '.' + p.classes.slice(0, 3).join('.') : ''}>`;
  const lines = [`Элемент на странице ${shortUrl(p.url)}: ${head}${p.text ? ` «${p.text}»` : ''}`];
  if (p.components?.length) lines.push(`- компонент: ${p.components.join(' ← ')}${p.source ? ` (${p.source})` : ''}`);
  else if (p.source) lines.push(`- файл: ${p.source}`);
  lines.push(`- селектор: ${p.selector}`);
  for (const [k, v] of Object.entries(p.attrs ?? {})) lines.push(`- ${ATTR_LABEL[k] ?? k}: ${v}`);
  lines.push(`- размер: ${p.width}×${p.height}`);
  return lines.join('\n');
}

/** Вставить описание в текст поля: отдельным абзацем, курсор — после, чтобы сразу дописать просьбу. */
export function insertPick(text: string, pick: string): string {
  const before = text.replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${pick}\n\n`;
}
