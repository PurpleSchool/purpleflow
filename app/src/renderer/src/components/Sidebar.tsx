import { memo, useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderGit2, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Rocket, Settings, Workflow } from 'lucide-react';
import type { ChatSummary, RunSummary, ToolName } from '@purpleflow/core';
import { useActions, useStore } from '../lib/store';
import { shortPath } from '../lib/format';
import { MODES } from '../lib/stages';
import { toolNeeded } from '../lib/tools';
import { bridge } from '../lib/api';

const TOOLS: ToolName[] = ['git', 'claude', 'codex', 'openspec'];

const STATUS_WORD: Record<RunSummary['status'], string> = {
  queued: 'в очереди',
  running: 'идёт',
  waiting: 'ждёт вас',
  stopped: 'остановлен',
  cancelled: 'отменён',
  finished: 'готово',
};

type Item = { kind: 'run'; at: string; run: RunSummary } | { kind: 'chat'; at: string; chat: ChatSummary };

/** История: прогоны и чаты вместе. Сначала прогоны, ждущие решения человека, остальное — по дням. */
function groupItems(runs: RunSummary[], chats: ChatSummary[]) {
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
  const label = (iso: string) => {
    const d = new Date(iso);
    if (day(iso) === today.toDateString()) return 'Сегодня';
    if (day(iso) === yesterday.toDateString()) return 'Вчера';
    if (d > weekAgo) return 'На этой неделе';
    return 'Ранее';
  };
  const groups: { title: string; items: Item[] }[] = [];
  if (waiting.length) groups.push({ title: 'Ждут вас', items: waiting.map((r) => ({ kind: 'run', at: r.createdAt, run: r })) });
  for (const it of rest) {
    const t = label(it.at);
    const g = groups.find((x) => x.title === t);
    if (g) g.items.push(it);
    else groups.push({ title: t, items: [it] });
  }
  return groups;
}

const projectName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Левая панель: «Создать» (задача или чат), история прогонов и чатов, настройки и инструменты. Сворачивается (⌘B). */
export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { state, go } = useStore();
  const v = state.view;
  const groups = useMemo(() => groupItems(state.runs, state.chats), [state.runs, state.chats]);
  // Пока не подключён ни один проект — кнопка «Как начать?» открывает онбординг первого проекта.
  const [noProjects, setNoProjects] = useState(false);
  useEffect(() => {
    void bridge.core
      .listProjects()
      .then((l) => setNoProjects(l.length === 0))
      .catch(() => {});
  }, [v.name, state.runs]);
  const waiting = state.runs.filter((r) => r.status === 'waiting').length;
  const toggleTitle = `${collapsed ? 'Показать' : 'Скрыть'} панель (${bridge.platform === 'darwin' ? '⌘' : 'Ctrl+'}B)`;
  const [menu, setMenu] = useState(false);
  const create = (kind: 'task' | 'chat') => {
    setMenu(false);
    go(kind === 'task' ? { name: 'new' } : { name: 'chat' });
  };

  if (collapsed) {
    return (
      <div className="side-mini drag">
        <button className="side-icon" title={toggleTitle} onClick={onToggle}>
          <PanelLeftOpen size={17} />
          {waiting > 0 && <span className="side-badge">{waiting}</span>}
        </button>
        <button className="side-icon" title="Новая задача" onClick={() => go({ name: 'new' })}>
          <Workflow size={17} />
        </button>
        <button className="side-icon" title="Новый чат" onClick={() => go({ name: 'chat' })}>
          <MessageSquare size={17} />
        </button>
        <button className="side-icon" title="Проекты" onClick={() => go({ name: 'projects' })}>
          <FolderGit2 size={17} />
        </button>
        {noProjects && (
          <button className="side-icon side-start-icon" title="Как начать?" onClick={() => go({ name: 'start' })}>
            <Rocket size={17} />
          </button>
        )}
      </div>
    );
  }

  return (
    <aside className="side">
      <div className="side-top drag">
        <div className="side-brand">
          <Mark size={22} />
          <span>PurpleFlow</span>
        </div>
        <button className="side-icon" title={toggleTitle} onClick={onToggle}>
          <PanelLeftClose size={17} />
        </button>
      </div>

      <div className="side-create">
        <button
          className={`side-new ${v.name === 'new' || (v.name === 'chat' && !v.chatId) ? 'is-on' : ''}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <Plus size={16} /> Создать <ChevronDown size={14} className={`side-new-chev ${menu ? 'is-open' : ''}`} />
        </button>
        {menu && (
          <>
            <div className="side-create-scrim" onClick={() => setMenu(false)} />
            <div className="side-create-menu" role="menu">
              <button role="menuitem" onClick={() => create('task')}>
                <span className="side-kind is-run">
                  <Workflow size={15} />
                </span>
                <span>
                  <strong>Задача</strong>
                  <small>План, реализация, тесты, ревью и приёмка</small>
                </span>
              </button>
              <button role="menuitem" onClick={() => create('chat')}>
                <span className="side-kind is-chat">
                  <MessageSquare size={15} />
                </span>
                <span>
                  <strong>Чат</strong>
                  <small>Вопросы и небольшие правки без конвейера</small>
                </span>
              </button>
            </div>
          </>
        )}
      </div>
      <button
        className={`side-link side-projects ${v.name === 'projects' || v.name === 'project' ? 'is-on' : ''}`}
        onClick={() => go({ name: 'projects' })}
      >
        <FolderGit2 size={16} /> Проекты
      </button>

      <nav className="side-list" aria-label="История">
        {!state.runsLoaded && (
          <div className="side-loading" aria-busy="true">
            <span className="spinner" />
            <span>Загружаю историю…</span>
          </div>
        )}
        {!state.runsLoaded && [0, 1, 2].map((i) => <div key={i} className="side-skel" style={{ animationDelay: `${i * 0.15}s` }} />)}
        {state.runsLoaded && groups.length === 0 && <p className="side-empty">Пока пусто. Создайте задачу или чат — они появятся здесь.</p>}
        {groups.map((g) => (
          <section key={g.title} className={`side-group ${g.title === 'Ждут вас' ? 'is-attention' : ''}`}>
            <h4>{g.title}</h4>
            {g.items.map((it) =>
              it.kind === 'run' ? (
                <RunRow key={it.run.id} r={it.run} on={v.name === 'run' && v.runId === it.run.id} />
              ) : (
                <ChatRow key={it.chat.id} c={it.chat} on={v.name === 'chat' && v.chatId === it.chat.id} />
              ),
            )}
          </section>
        ))}
      </nav>

      <div className="side-bottom">
        {noProjects && (
          <button className="side-link side-start" onClick={() => go({ name: 'start' })}>
            <Rocket size={16} /> Как начать?
          </button>
        )}
        <button className={`side-link ${v.name === 'settings' ? 'is-on' : ''}`} onClick={() => go({ name: 'settings' })}>
          <Settings size={16} /> Настройки
        </button>
        <div className="side-tools" title="Найденные инструменты">
          {TOOLS.map((t) => {
            const info = state.tools?.[t];
            const ok = info?.path && !info.error;
            const needed = toolNeeded(t, state.settings?.agents);
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
const RunRow = memo(function RunRow({ r, on }: { r: RunSummary; on: boolean }) {
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
          <span className="side-run-project">{r.missing ? 'run.json не найден' : projectName(r.projectPath)}</span>
          {!r.missing && <span className="side-run-mode">{MODES.find((m) => m.id === (r.mode ?? 'task'))?.title}</span>}
        </span>
      </span>
    </button>
  );
});

const ChatRow = memo(function ChatRow({ c, on }: { c: ChatSummary; on: boolean }) {
  const { go } = useActions();
  return (
    <button
      className={`side-run side-chat-row ${c.busy ? 'st-running' : c.last === 'error' ? 'st-stopped' : c.last === 'ok' ? 'st-finished' : 'st-new'} ${on ? 'is-on' : ''}`}
      title={`Чат · ${c.title}\n${c.projectPath ? shortPath(c.projectPath) : 'без проекта'} · ${c.agent}`}
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
        <span className="side-run-title">{c.title}</span>
        <span className="side-run-sub">
          <span className="side-run-project">{c.projectPath ? projectName(c.projectPath) : 'без проекта'}</span>
          <span className="side-run-mode">Чат · {c.agent}</span>
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
