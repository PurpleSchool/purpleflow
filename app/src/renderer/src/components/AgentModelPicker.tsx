// Одна кнопка «агент · модель» под полем чата. Меню в два уровня: слева агенты со знаками нейросетей, справа — модели
// выбранного агента; поиск сверху ищет по всем агентам сразу. Выбор модели выбирает и агента.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { AgentKind } from '@purpleflow/core';
import { familyLabel, familyOf, modelName, pickerSections, type PickItem } from '../lib/agentPicker';
import { PROXY_ONLY_BADGE, proxyOnly } from '../lib/models';
import { useStore } from '../lib/store';
import { usePopover, useOutside, type DropOption } from './Dropdown';
import { SubscriptionGate } from './ModelInput';
import { AgentLogo } from './VendorIcon';

/** Пункт левой колонки: свои модели агента или семейство моделей по подписке PurpleSchool (DeepSeek, Gemini…). */
interface Entry {
  agent: AgentKind;
  /** null — свои модели агента. */
  family: string | null;
}
const sameEntry = (x: Entry, y: Entry) => x.agent === y.agent && x.family === y.family;
const isPs = (i: PickItem) => i.option?.badge === PROXY_ONLY_BADGE;
/** Пункт левой колонки, к которому относится модель. */
const entryOf = (i: PickItem): Entry => ({ agent: i.agent, family: isPs(i) ? familyOf(i.model) : null });

export function AgentModelPicker({
  agents,
  agent,
  model,
  fallback,
  options,
  missing,
  disabled,
  onPick,
}: {
  /** Включённые агенты — разделы списка. */
  agents: AgentKind[];
  agent: AgentKind;
  /** Своя модель чата; '' — по умолчанию. */
  model: string;
  /** Модель по умолчанию у текущего агента — видна на кнопке, пока своей нет. */
  fallback: string;
  options: Record<AgentKind, DropOption<string>[]>;
  missing: (a: AgentKind) => boolean;
  disabled?: boolean;
  onPick: (agent: AgentKind, model: string) => void;
}) {
  const { state } = useStore();
  const proxy = state.settings?.proxy;
  const viaProxy = Boolean(proxy?.enabled && proxy.hasKey);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** Пункт слева, чьи модели показаны справа (без поиска). */
  const [focus, setFocus] = useState<Entry>({ agent, family: null });
  const [gate, setGate] = useState<{ agent: AgentKind; model: string } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Наведение переключает пункт слева с задержкой: путь мыши наискосок к моделям не цепляет соседние пункты.
  const hoverTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const pop = usePopover(open, btn, 540, 480);
  useOutside(open, [btn, list], close);

  const searching = query.trim() !== '';
  const found = pickerSections(agents, options, agent, query).filter((s) => s.items.length);
  // Слева: агент, под ним — семейства его моделей по подписке PurpleSchool. Без поиска справа — модели выбранного пункта;
  // с поиском — совпадения у всех агентов, по разделам.
  const all = pickerSections(agents, options, agent, '').flatMap((sec) => sec.items);
  const entries: Entry[] = agents.flatMap((a) => {
    const fams = [...new Set(all.filter((i) => i.agent === a && isPs(i)).map((i) => familyOf(i.model)))];
    return [{ agent: a, family: null }, ...fams.map((family) => ({ agent: a, family }))];
  });
  const sections = searching
    ? found
    : found
        .filter((sec) => sec.agent === focus.agent)
        .map((sec) => ({ ...sec, items: sec.items.filter((i) => sameEntry(entryOf(i), focus)) }))
        .filter((sec) => sec.items.length);
  const flat = sections.flatMap((sec) => sec.items);
  const itemsOf = (e: Entry) => all.filter((i) => sameEntry(entryOf(i), e));
  const isOn = (i: PickItem) => i.agent === agent && i.model === model;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const show = () => {
    setQuery('');
    const cur = all.find((i) => i.agent === agent && i.model === model);
    const e = cur ? entryOf(cur) : { agent, family: null };
    setFocus(e);
    setActive(
      Math.max(
        0,
        itemsOf(e).findIndex((i) => i.model === model),
      ),
    );
    setOpen(true);
  };
  /** Слева выбрали пункт: справа его модели, подсветка — на текущей модели, если она там. */
  const focusEntry = (e: Entry) => {
    if (sameEntry(e, focus) && !searching) return;
    setQuery('');
    setFocus(e);
    setActive(
      Math.max(
        0,
        itemsOf(e).findIndex((i) => i.agent === agent && i.model === model),
      ),
    );
  };
  const pick = (i: PickItem) => {
    setOpen(false);
    btn.current?.focus();
    if (!viaProxy && proxyOnly(options[i.agent] ?? [], i.model)) return setGate({ agent: i.agent, model: i.model });
    if (i.agent !== agent || i.model !== model) onPick(i.agent, i.model);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (!searching && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      // Без поиска стрелки вбок переключают агента слева.
      e.preventDefault();
      const i = entries.findIndex((x) => sameEntry(x, focus)) + (e.key === 'ArrowRight' ? 1 : -1);
      if (entries[i]) focusEntry(entries[i]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[active]) pick(flat[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      btn.current?.focus();
    }
  };

  let n = -1;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`dd amp ${open ? 'is-open' : ''}`}
        disabled={disabled}
        aria-label="Агент и модель"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={missing(agent) ? `${agent} не найден` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <AgentLogo agent={agent} />
        <span className="amp-agent">{agent}</span>
        <span className="amp-sep">·</span>
        <span className={`amp-model ${model ? '' : 'is-default'}`} title={model || fallback || undefined}>
          {model || fallback ? modelName(model || fallback) : 'по умолчанию'}
        </span>
        <ChevronDown size={14} className="dd-chev" />
      </button>
      {open &&
        pop.container &&
        createPortal(
          <div className="dd-pop amp-pop" style={{ ...pop.style, height: pop.style.maxHeight }} ref={list}>
            <label className="amp-search">
              <Search size={13} />
              <input
                ref={input}
                value={query}
                spellCheck={false}
                placeholder="Найти модель"
                aria-label="Найти модель"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
            </label>
            <div className={`amp-cols ${searching ? 'is-search' : ''}`}>
              {/* Пока идёт поиск, колонки агентов нет — результаты на всю ширину, по разделам. */}
              {!searching && (
                <div className="amp-agents" role="tablist" aria-label="Агенты" aria-orientation="vertical">
                  {entries.map((e) => {
                    const on = sameEntry(e, focus);
                    return (
                      <button
                        key={`${e.agent}:${e.family ?? ''}`}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        aria-label={e.family ? `${e.agent}: ${familyLabel(e.family)}` : e.agent}
                        className={`amp-agent-row ${on ? 'is-on' : ''} ${!e.family && missing(e.agent) ? 'is-missing' : ''}`}
                        title={!e.family && missing(e.agent) ? `${e.agent} не найден` : undefined}
                        onMouseEnter={() => {
                          window.clearTimeout(hoverTimer.current);
                          hoverTimer.current = window.setTimeout(() => focusEntry(e), 180);
                        }}
                        onMouseLeave={() => window.clearTimeout(hoverTimer.current)}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => focusEntry(e)}
                      >
                        <AgentLogo agent={e.family ?? e.agent} size="l" />
                        <span className="amp-agent-name">{e.family ? familyLabel(e.family) : e.agent}</span>
                        <ChevronRight size={13} className="amp-agent-chev" />
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="amp-models" role="listbox" aria-label="Агент и модель">
                {sections.length === 0 && <div className="dd-empty">Ничего не найдено</div>}
                {sections.map((s) => (
                  <div key={s.agent} role="group" aria-label={s.agent} className="amp-group">
                    {searching && (
                      <div className="amp-head">
                        <AgentLogo agent={s.agent} />
                        {s.agent}
                        {missing(s.agent) && <em> · не найден</em>}
                      </div>
                    )}
                    {s.items.map((i) => {
                      const idx = ++n;
                      const on = isOn(i);
                      return (
                        <button
                          key={i.model}
                          type="button"
                          role="option"
                          data-i={idx}
                          aria-selected={on}
                          className={`dd-opt ${idx === active ? 'is-active' : ''} ${on ? 'is-on' : ''}`}
                          onMouseEnter={() => setActive(idx)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(i)}
                        >
                          {/* Одна строка у всех: название; у «по умолчанию» — какая это модель. */}
                          <span className="dd-opt-text" title={i.model || undefined}>
                            <span className="dd-opt-label">
                              {i.model ? modelName(i.model) : 'по умолчанию'}
                              {!i.model && i.agent === agent && fallback && (
                                <span className="amp-default-of"> · {modelName(fallback)}</span>
                              )}
                            </span>
                          </span>
                          {i.option?.badge && (searching || !isPs(i)) && (
                            <span className="dd-badge" title={i.option.badgeTitle}>
                              {i.option.badge}
                            </span>
                          )}
                          {on && <Check size={14} className="dd-opt-check" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>,
          pop.container,
        )}
      {gate && <SubscriptionGate model={gate.model} onClose={() => setGate(null)} onEnabled={() => onPick(gate.agent, gate.model)} />}
    </>
  );
}
