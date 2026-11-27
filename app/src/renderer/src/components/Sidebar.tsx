import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bug,
  CalendarDays,
  ChevronDown,
  FolderGit2,
  FolderPlus,
  Gift,
  House,
  LayoutGrid,
  LayoutList,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Search,
  Settings,
  Workflow,
  X,
} from 'lucide-react';
import type { ChatSummary, ProjectListItem, RunSummary } from '@purpleflow/core';
import { useActions, useStore } from '../lib/store';
import { shortPath, when } from '../lib/format';
import { MODES } from '../lib/stages';
import { shownTools, toolNeeded } from '../lib/tools';
import { bridge } from '../lib/api';
import { openWhatsNew, useUpdateState } from '../lib/update';
import { recentProjects } from '../lib/recentProjects';
import { UpdateButton, updatePending } from './WhatsNew';
import { PillTabs } from './PillTabs';
import { ChatTitleText } from './ChatTitle';
import { Select } from './Dropdown';

const STATUS_WORD: Record<RunSummary['status'], string> = {
  queued: 'в очереди',
  running: 'идёт',
  waiting: 'ждёт вас',
  stopped: 'остановлен',
  cancelled: 'отменён',
  finished: 'готово',
};

type Filter = 'all' | 'chats' | 'tasks';
const FILTER_KEY = 'purpleflow.sideFilter';
const EMPTY: Record<Filter, string> = {
  all: 'Пока пусто. Создайте задачу или чат — они появятся здесь.',
  chats: 'Чатов пока нет.',
  tasks: 'Задач пока нет.',
};

type Item = { kind: 'run'; at: string; run: RunSummary } | { kind: 'chat'; at: string; chat: ChatSummary };

type GroupBy = 'date' | 'project';
const GROUP_KEY = 'purpleflow.sideGroupBy';
/** Сколько строк истории показывать сразу; дальше — ещё столько же, когда список докручен до конца. */
const PAGE = 60;
const NO_PROJECT = 'Без проекта';

/** История: прогоны и чаты вместе. Сначала прогоны, ждущие решения человека, остальное — по дням или по проектам. */
function groupItems(runs: RunSummary[], chats: ChatSummary[], by: GroupBy = 'date') {
  const waiting = runs.filter((r) => r.status === 'waiting');
  const rest: Item[] = [
    ...runs.filter((r) => r.status !== 'waiting').map((r) => ({ kind: 'run' as const, at: r.createdAt, run: r })),
    ...chats.map((c) => ({ kind: 'chat' as const, at: c.updatedAt, chat: c })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const day = (iso: string) => new Date(iso).toDateString();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const dateLabel = (iso: string) => {
    const d = new Date(iso);
    if (day(iso) === today.toDateString()) return 'Сегодня';
    if (day(iso) === yesterday.toDateString()) return 'Вчера';
    if (d > weekAgo) return 'На этой неделе';
    return 'Ранее';
  };
  const groups: { title: string; items: Item[] }[] = [];
  if (waiting.length) groups.push({ title: 'Ждут вас', items: waiting.map((r) => ({ kind: 'run', at: r.createdAt, run: r })) });
  // По проектам: группы — в порядке последней активности (список уже отсортирован), «Без проекта» — в конце.
  const projectLabel = (it: Item) => {
    const path = it.kind === 'run' ? it.run.projectPath : it.chat.projectPath;
    return path ? projectName(path) : NO_PROJECT;
  };
  for (const it of rest) {
    const t = by === 'project' ? projectLabel(it) : dateLabel(it.at);
    const g = groups.find((x) => x.title === t);
    if (g) g.items.push(it);
    else groups.push({ title: t, items: [it] });
  }
  if (by === 'project') {
    const none = groups.findIndex((g) => g.title === NO_PROJECT);
    if (none >= 0) groups.push(...groups.splice(none, 1));
  }
  return groups;
}

/** Первые limit строк истории — по группам, без пустых групп. */
function takeItems(groups: { title: string; items: Item[] }[], limit: number) {
  const out: typeof groups = [];
  let left = limit;
  for (const g of groups) {
    if (left <= 0) break;
    out.push({ title: g.title, items: g.items.slice(0, left) });
    left -= g.items.length;
  }
  return out;
}

const projectName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Поиск по истории: каждое слово запроса — в названии или в имени проекта, без учёта регистра. */
export function matchesQuery(query: string, title: string, project: string | undefined): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${title} ${project ? projectName(project) : 'без проекта'}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Ширина панели: тянется за правый край, запоминается; двойной клик по краю — обратно по умолчанию. */
const WIDTH_KEY = 'purpleflow.sideWidth';
const SIDE_W = { min: 220, max: 440, def: 264 };
const clampW = (w: number) => Math.round(Math.min(SIDE_W.max, Math.max(SIDE_W.min, w)));
function applySideWidth(w: number) {
  document.documentElement.style.setProperty('--side-w', `${w}px`);
}
try {
  const saved = Number(localStorage.getItem(WIDTH_KEY));
  if (saved) applySideWidth(clampW(saved));
} catch {
  /* по умолчанию */
}

function SideResize() {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const left = handle.parentElement!.getBoundingClientRect().left;
    let width = clampW(e.clientX - left);
    document.body.classList.add('is-nav-resizing');
    const move = (ev: PointerEvent) => {
      width = clampW(ev.clientX - left);
      applySideWidth(width);
    };
    const end = () => {
      document.body.classList.remove('is-nav-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* без запоминания */
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  return (
    <div
      className="nav-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Ширина панели"
      title="Потяните, чтобы изменить ширину; двойной клик — как было"
      onPointerDown={start}
      onDoubleClick={() => {
        applySideWidth(SIDE_W.def);
        try {
          localStorage.removeItem(WIDTH_KEY);
        } catch {
          /* ничего */
        }
      }}
    />
  );
}

/** Левая панель: «Создать» (задача или чат), история прогонов и чатов, настройки и инструменты. Сворачивается (⌘B). */
export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { state, go } = useStore();
  const v = state.view;
  const update = useUpdateState();
  // История целиком, только чаты или только задачи — выбор запоминается.
  const [filter, setFilterState] = useState<Filter>(() => {
    try {
      const f = localStorage.getItem(FILTER_KEY);
      return f === 'chats' || f === 'tasks' ? f : 'all';
    } catch {
      return 'all';
    }
  });
  const setFilter = (f: Filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* без запоминания */
    }
  };
  // Поиск по названию и проекту — внутри выбранного фильтра.
  const [query, setQuery] = useState('');
  // Поиск — круглая кнопка справа от фильтра; открытый занимает строку фильтра.
  const [searching, setSearching] = useState(false);
  const closeSearch = () => {
    setQuery('');
    setSearching(false);
  };
  // ⌘K / Ctrl+K — открыть поиск (или вернуть в него фокус).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  // Группировать по дате или по проектам — выбор справа от первого заголовка, запоминается.
  const [groupBy, setGroupByState] = useState<GroupBy>(() => {
    try {
      return localStorage.getItem(GROUP_KEY) === 'project' ? 'project' : 'date';
    } catch {
      return 'date';
    }
  });
  const setGroupBy = (g: GroupBy) => {
    setGroupByState(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      /* без запоминания */
    }
  };
  const allGroups = useMemo(
    () =>
      groupItems(
        filter === 'chats' ? [] : state.runs.filter((r) => matchesQuery(query, r.title, r.projectPath)),
        filter === 'tasks' ? [] : state.chats.filter((c) => matchesQuery(query, c.title, c.projectPath)),
        groupBy,
      ),
    [state.runs, state.chats, filter, query, groupBy],
  );
  // Длинная история рисуется частями: сначала PAGE строк, ещё PAGE — когда низ списка показался на экране.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, query, groupBy]);
  const total = useMemo(() => allGroups.reduce((n, g) => n + g.items.length, 0), [allGroups]);
  const groups = useMemo(() => takeItems(allGroups, limit), [allGroups, limit]);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current;
    if (!el || total <= limit) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setLimit((l) => l + PAGE), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [total, limit]);
  // Пока не подключён ни один проект — кнопка «Как начать?» открывает онбординг первого проекта.
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  useEffect(() => {
    void bridge.core
      .listProjects()
      .then(setProjects)
      .catch(() => {});
  }, [v.name, state.runs]);
  const noProjects = projects?.length === 0;
  const recent = useMemo(() => recentProjects(projects ?? [], state.chats), [projects, state.chats]);
  const [projMenu, setProjMenu] = useState(false);
  const openProject = (path: string | null) => {
    setProjMenu(false);
    go(path ? { name: 'project', path } : { name: 'projects' });
  };
  const waiting = state.runs.filter((r) => r.status === 'waiting').length;
  const toggleTitle = `${collapsed ? 'Показать' : 'Скрыть'} панель (${bridge.platform === 'darwin' ? '⌘' : 'Ctrl+'}B)`;
  const [menu, setMenu] = useState(false);
  const create = (kind: 'task' | 'chat') => {
    setMenu(false);
    go(kind === 'task' ? { name: 'new' } : { name: 'chat' });
  };

  if (collapsed) {
    // Свёрнутая панель — узкая колонка иконок: главное под рукой, настройки внизу.
    const rail = (title: string, icon: ReactNode, onClick: () => void, on = false, extra?: ReactNode) => (
      <button type="button" className={`side-icon side-rail-btn ${on ? 'is-on' : ''}`} title={title} aria-label={title} onClick={onClick}>
        {icon}
        {extra}
      </button>
    );
    return (
      <nav className="side-rail drag" aria-label="Панель">
        {rail(
          toggleTitle,
          <PanelLeftOpen size={18} />,
          onToggle,
          false,
          waiting > 0 ? <span className="side-badge">{waiting}</span> : undefined,
        )}
        <span className="side-rail-sep" />
        {rail('Главная', <House size={18} />, () => go({ name: 'home' }), v.name === 'home')}
        {rail('Новый чат', <MessageSquare size={18} />, () => go({ name: 'chat' }), v.name === 'chat' && !v.chatId)}
        {rail('Новая задача', <Workflow size={18} />, () => go({ name: 'new' }), v.name === 'new')}
        {rail('Проекты', <FolderGit2 size={18} />, () => go({ name: 'projects' }), v.name === 'projects' || v.name === 'project')}
        <span className="grow" />
        {noProjects && rail('Как начать?', <Rocket size={18} />, () => go({ name: 'start' }))}
        {rail(
          'Что нового',
          <Gift size={18} />,
          openWhatsNew,
          false,
          updatePending(update) || update.kind === 'failed' ? (
            <i className={`side-dot side-rail-dot ${update.kind === 'failed' ? 'is-err' : ''}`} aria-label="Есть обновление" />
          ) : undefined,
        )}
        {rail('Настройки', <Settings size={18} />, () => go({ name: 'settings' }), v.name === 'settings')}
      </nav>
    );
  }

  return (
    <aside className="side">
      <SideResize />
      <div className="side-top drag">
        <button type="button" className="side-brand" title="Главная" aria-label="Главная" onClick={() => go({ name: 'home' })}>
          <Mark size={22} />
          <span>PurpleFlow</span>
        </button>
        <button className="side-icon" title={toggleTitle} onClick={onToggle}>
          <PanelLeftClose size={17} />
        </button>
      </div>

      {/* Как строка фильтра ниже: широкая таблетка «Создать» и круглая кнопка «Проекты» справа. Главная — по логотипу. */}
      <div className="side-actions">
        <div className="side-create side-create-new">
          <button
            title="Создать чат или задачу"
            aria-label="Создать"
            className={`side-new ${v.name === 'new' || (v.name === 'chat' && !v.chatId) ? 'is-on' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Plus size={16} />
            <span className="side-new-label">Создать</span>
            <ChevronDown size={14} className={`side-new-chev ${menu ? 'is-open' : ''}`} />
          </button>
          {menu && (
            <>
              <div className="side-create-scrim" onClick={() => setMenu(false)} />
              <div className="side-create-menu" role="menu">
                <button role="menuitem" onClick={() => create('chat')}>
                  <span className="side-kind is-chat">
                    <MessageSquare size={15} />
                  </span>
                  <span>
                    <strong>Чат</strong>
                    <small>Вопросы и небольшие правки без конвейера</small>
                  </span>
                </button>
                <button role="menuitem" onClick={() => create('task')}>
                  <span className="side-kind is-run">
                    <Workflow size={15} />
                  </span>
                  <span>
                    <strong>Задача</strong>
                    <small>План, реализация, тесты, ревью и приёмка</small>
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
        <div className="side-create">
          <button
            className={`side-round ${v.name === 'projects' || v.name === 'project' || projMenu ? 'is-on' : ''}`}
            aria-label="Проекты"
            title="Проекты"
            aria-haspopup={recent.length ? 'menu' : undefined}
            aria-expanded={recent.length ? projMenu : undefined}
            // Проектов ещё нет — сразу на экран «Проекты»: там «Новый проект» и «Открыть папку…».
            onClick={() => (recent.length ? setProjMenu(!projMenu) : go({ name: 'projects' }))}
          >
            <FolderGit2 size={16} />
          </button>
          {projMenu && (
            <>
              <div className="side-create-scrim" onClick={() => setProjMenu(false)} />
              <div className="side-create-menu side-projects-menu" role="menu" aria-label="Последние проекты">
                {recent.map((p) => (
                  <button
                    key={p.path}
                    role="menuitem"
                    className={v.name === 'project' && v.path === p.path ? 'is-on' : ''}
                    title={p.root ?? p.path}
                    onClick={() => openProject(p.path)}
                  >
                    <span className="side-kind">
                      <FolderGit2 size={14} />
                    </span>
                    <span className="side-project-name">
                      <strong>{projectName(p.root ?? p.path)}</strong>
                      <small>{shortPath(p.root ?? p.path)}</small>
                    </span>
                    {p.active > 0 && (
                      <span className="side-project-active" title="Идут, ждут решения или в очереди">
                        {p.active}
                      </span>
                    )}
                  </button>
                ))}
                <div className="side-menu-sep" />
                <button
                  role="menuitem"
                  className="side-projects-all"
                  onClick={() => {
                    setProjMenu(false);
                    go({ name: 'addProject' });
                  }}
                >
                  <FolderPlus size={14} /> Новый проект
                </button>
                <button role="menuitem" className="side-projects-all" onClick={() => openProject(null)}>
                  <LayoutGrid size={14} /> Все проекты
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className={`side-filter ${searching ? 'is-searching' : ''}`}>
        {searching ? (
          <div className="side-search">
            <Search size={14} aria-hidden />
            <input
              ref={searchRef}
              autoFocus
              type="search"
              value={query}
              placeholder={filter === 'tasks' ? 'Найти задачу' : filter === 'chats' ? 'Найти чат' : 'Найти чат или задачу'}
              aria-label="Поиск по истории"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
              // Ушли из пустого поиска — снова фильтр.
              onBlur={() => !query.trim() && setSearching(false)}
            />
            <button
              type="button"
              className="side-search-clear"
              aria-label="Закрыть поиск"
              // Не терять фокус до клика: иначе blur закроет поиск раньше.
              onMouseDown={(e) => e.preventDefault()}
              onClick={closeSearch}
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <>
            <PillTabs<Filter>
              className="tabs"
              value={filter}
              onChange={setFilter}
              minLevel={1}
              items={[
                { id: 'all', label: 'Все', icon: <LayoutList size={14} /> },
                { id: 'chats', label: 'Чаты', icon: <MessageSquare size={14} /> },
                {
                  id: 'tasks',
                  label: 'Задачи',
                  icon: <Workflow size={14} />,
                  extra: waiting ? (
                    <span className="tab-badge is-wait" title="Ждут вашего решения">
                      {waiting}
                    </span>
                  ) : undefined,
                },
              ]}
            />
            <button
              type="button"
              className="side-round"
              aria-label="Поиск по истории"
              title={`Найти чат или задачу (${bridge.platform === 'darwin' ? '⌘' : 'Ctrl+'}K)`}
              onClick={() => setSearching(true)}
            >
              <Search size={15} />
            </button>
          </>
        )}
      </div>

      <nav className="side-list tab-enter" key={filter} aria-label="История">
        {!state.runsLoaded && (
          <div className="side-loading" aria-busy="true">
            <span className="spinner" />
            <span>Загружаю историю…</span>
          </div>
        )}
        {!state.runsLoaded && [0, 1, 2].map((i) => <div key={i} className="side-skel" style={{ animationDelay: `${i * 0.15}s` }} />)}
        {state.runsLoaded && groups.length === 0 && <p className="side-empty">{query.trim() ? 'Ничего не нашлось.' : EMPTY[filter]}</p>}
        {groups.map((g, i) => (
          <section key={g.title} className={`side-group ${g.title === 'Ждут вас' ? 'is-attention' : ''}`}>
            <div className="side-group-head">
              <h4>{g.title}</h4>
              {i === 0 && (
                <Select<GroupBy>
                  className="side-group-by"
                  value={groupBy}
                  ariaLabel="Группировать историю"
                  title="Группировать по дате или по проектам"
                  icon={groupBy === 'date' ? <CalendarDays size={12} /> : <FolderGit2 size={12} />}
                  minWidth={170}
                  options={[
                    { value: 'date', label: 'По дате', icon: <CalendarDays size={14} /> },
                    { value: 'project', label: 'По проектам', icon: <FolderGit2 size={14} /> },
                  ]}
                  onChange={setGroupBy}
                />
              )}
            </div>
            {g.items.map((it) =>
              it.kind === 'run' ? (
                <RunRow
                  key={it.run.id}
                  r={it.run}
                  on={v.name === 'run' && v.runId === it.run.id}
                  sub={groupBy === 'project' ? when(it.at) : undefined}
                />
              ) : (
                <ChatRow
                  key={it.chat.id}
                  c={it.chat}
                  on={v.name === 'chat' && v.chatId === it.chat.id}
                  sub={groupBy === 'project' ? when(it.at) : undefined}
                />
              ),
            )}
          </section>
        ))}
        {total > limit && <div ref={more} className="side-more" aria-hidden />}
      </nav>

      <div className="side-bottom">
        {noProjects && (
          <button className="side-link side-start" onClick={() => go({ name: 'start' })}>
            <Rocket size={16} /> Как начать?
          </button>
        )}
        {/* Есть обновление — своей строкой над настройками; нет — строки нет. */}
        {(updatePending(update) || update.kind === 'failed') && (
          <div className={`side-whatsnew side-update ${update.kind === 'failed' ? 'is-err' : ''}`}>
            <i className={`side-dot ${update.kind === 'failed' ? 'is-err' : ''}`} aria-hidden />
            <span className="side-update-text">
              {update.kind === 'failed' ? 'Обновление не удалось' : 'version' in update ? `Версия ${update.version}` : 'Новая версия'}
            </span>
            <UpdateButton s={update} compact />
          </div>
        )}
        <div className="side-settings">
          <button className={`side-link ${v.name === 'settings' ? 'is-on' : ''}`} onClick={() => go({ name: 'settings' })}>
            <Settings size={16} /> Настройки
          </button>
          {/* «Что нового» и «Сообщить о проблеме» — значками справа от настроек. */}
          <button className="side-bug" aria-label="Что нового" onClick={openWhatsNew}>
            <Gift size={16} />
            {(updatePending(update) || update.kind === 'failed') && (
              <i className={`side-dot side-icon-dot ${update.kind === 'failed' ? 'is-err' : ''}`} aria-label="Есть обновление" />
            )}
            <span className="side-tip" role="tooltip">
              <strong>Что нового</strong>
              <span>Изменения в версиях и обновление приложения</span>
            </span>
          </button>
          <button
            className="side-bug"
            aria-label="Сообщить о проблеме"
            onClick={() =>
              void bridge.reportBug(
                shownTools(state.settings?.enabledAgents).map((t) => ({ name: t, version: state.tools?.[t]?.version ?? undefined })),
              )
            }
          >
            <Bug size={16} />
            <span className="side-tip" role="tooltip">
              <strong>Сообщить о проблеме</strong>
              <span>Откроется issue на GitHub — версия и окружение уже подставлены</span>
            </span>
          </button>
        </div>
        <div className="side-tools" title="Найденные инструменты">
          {shownTools(state.settings?.enabledAgents).map((t) => {
            const info = state.tools?.[t];
            const ok = info?.path && !info.error;
            const needed = toolNeeded(t, state.settings?.agents, state.settings?.enabledAgents);
            return (
              <span
                key={t}
                className={`tool-chip ${state.toolsLoading && !info ? 'is-loading' : ok ? 'is-ok' : needed ? 'is-bad' : 'is-off'}`}
                title={info ? `${info.path ?? 'не найден'} ${info.version ?? ''}` : 'проверяем…'}
              >
                <i />
                {t}
              </span>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

/** Прогон задачи: иконка flow, цвет — статус. */
/** sub — подпись под названием вместо проекта: в группах по проектам там дата. */
const RunRow = memo(function RunRow({ r, on, sub }: { r: RunSummary; on: boolean; sub?: string }) {
  const { go } = useActions();
  return (
    <button
      className={`side-run st-${r.status} ${on ? 'is-on' : ''}`}
      disabled={r.missing}
      title={
        r.missing ? `run.json не найден: ${r.runJsonPath}` : `Задача · ${r.title}\n${shortPath(r.projectPath)} · ${STATUS_WORD[r.status]}`
      }
      onClick={() => go({ name: 'run', runId: r.id })}
    >
      <span className="side-kind is-run" aria-label={`Задача · ${STATUS_WORD[r.status]}`}>
        <Workflow size={13} />
        <span className="side-dot" />
      </span>
      <span className="side-run-text">
        <span className="side-run-title">{r.title}</span>
        <span className="side-run-sub">
          <span className="side-run-project">{r.missing ? 'run.json не найден' : (sub ?? projectName(r.projectPath))}</span>
          {!r.missing && <span className="side-run-mode">{MODES.find((m) => m.id === (r.mode ?? 'task'))?.title}</span>}
        </span>
      </span>
    </button>
  );
});

const ChatRow = memo(function ChatRow({ c, on, sub }: { c: ChatSummary; on: boolean; sub?: string }) {
  const { go } = useActions();
  return (
    <button
      className={`side-run side-chat-row ${c.busy ? 'st-running' : c.last === 'error' ? 'st-stopped' : c.last === 'ok' ? 'st-finished' : 'st-new'} ${on ? 'is-on' : ''}`}
      title={`Чат · ${c.title}\n${c.projectPath ? shortPath(c.projectPath) : 'без проекта'}`}
      onClick={() => go({ name: 'chat', chatId: c.id })}
    >
      <span
        className="side-kind is-chat"
        aria-label={`Чат · ${c.busy ? 'агент отвечает' : c.last === 'error' ? 'ошибка' : c.last === 'ok' ? 'ответ готов' : 'новый'}`}
      >
        <MessageSquare size={13} />
        {c.last || c.busy ? <span className="side-dot" /> : null}
      </span>
      <span className="side-run-text">
        <ChatTitleText className="side-run-title" title={c.title} titling={c.titling} />
        <span className="side-run-sub">
          <span className="side-run-project">{sub ?? (c.projectPath ? projectName(c.projectPath) : 'без проекта')}</span>
          <span className="side-run-mode">Чат</span>
        </span>
      </span>
    </button>
  );
});

/** Знак PurpleSchool (purpleschool.ru): две встречные скобки. */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="-2 12.5 40 36" aria-hidden>
      <path
        d="M17.4634 38.706C17.3794 38.706 17.2674 38.678 17.1274 38.622C17.0154 38.566 16.8894 38.51 16.7494 38.454L1.62937 28.164C1.23737 27.884 0.929367 27.618 0.705367 27.366C0.509367 27.086 0.411367 26.736 0.411367 26.316V25.014C0.411367 24.594 0.509367 24.258 0.705367 24.006C0.929367 23.754 1.23737 23.488 1.62937 23.208L16.7494 12.918C16.8894 12.834 17.0154 12.764 17.1274 12.708C17.2674 12.652 17.3794 12.624 17.4634 12.624C17.7154 12.624 17.9254 12.708 18.0934 12.876C18.2614 13.044 18.3454 13.254 18.3454 13.506V18C18.3454 18.448 18.2194 18.798 17.9674 19.05C17.7154 19.274 17.4494 19.484 17.1694 19.68L8.01337 25.686L17.1694 31.734C17.4494 31.902 17.7154 32.098 17.9674 32.322C18.2194 32.546 18.3454 32.882 18.3454 33.33V37.866C18.3454 38.118 18.2614 38.328 18.0934 38.496C17.9254 38.636 17.7154 38.706 17.4634 38.706Z"
        fill="#E47AD5"
      />
      <path
        d="M18.5366 22.294C18.6206 22.294 18.7326 22.322 18.8726 22.378C18.9846 22.434 19.1106 22.49 19.2506 22.546L34.3706 32.836C34.7626 33.116 35.0706 33.382 35.2946 33.634C35.4906 33.914 35.5886 34.264 35.5886 34.684L35.5886 35.986C35.5886 36.406 35.4906 36.742 35.2946 36.994C35.0706 37.246 34.7626 37.512 34.3706 37.792L19.2506 48.082C19.1106 48.166 18.9846 48.236 18.8726 48.292C18.7326 48.348 18.6206 48.376 18.5366 48.376C18.2846 48.376 18.0746 48.292 17.9066 48.124C17.7386 47.956 17.6546 47.746 17.6546 47.494L17.6546 43C17.6546 42.552 17.7806 42.202 18.0326 41.95C18.2846 41.726 18.5506 41.516 18.8306 41.32L27.9866 35.314L18.8306 29.266C18.5506 29.098 18.2846 28.902 18.0326 28.678C17.7806 28.454 17.6546 28.118 17.6546 27.67L17.6546 23.134C17.6546 22.882 17.7386 22.672 17.9066 22.504C18.0746 22.364 18.2846 22.294 18.5366 22.294Z"
        fill="#6C38CC"
      />
    </svg>
  );
}
