import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Check, PanelLeftClose, Pause, RotateCcw, SquareTerminal, StickyNote, Undo2, UserRoundCog, X } from 'lucide-react';
import type { ManagerAction, ManagerMessage, RunFile } from '@purpleflow/core';
import { Markdown } from '../../components/Markdown';
import { onCoreEvent } from '../../lib/store';
import { cleanErr } from './util';

const ACTION: Record<ManagerAction['kind'], { title: string; icon: ReactNode; hint: string }> = {
  command: { title: 'Выполнить команду', icon: <SquareTerminal size={14} />, hint: '' },
  note: { title: 'Заметка агенту', icon: <StickyNote size={14} />, hint: 'Уйдёт при следующем запуске планировщика или исполнителя' },
  pause: { title: 'Пауза', icon: <Pause size={14} />, hint: 'Остановится перед следующей стадией' },
  restart: { title: 'Переделать попытку', icon: <RotateCcw size={14} />, hint: 'Текущая реализация прервётся сразу' },
  replan: { title: 'Вернуть к плану', icon: <Undo2 size={14} />, hint: '' },
};

const SUGGEST = ['Как идут дела?', 'Что сейчас мешает?', 'Что уже сделано по плану?'];

const LAYOUT_KEY = 'purpleflow.manager';
const DEFAULT_W = 300;
const MIN_W = 240;
const MAX_W = 640;
const RAIL_W = 56;

/** Ширина чата и свёрнут ли он — запоминаются для всех прогонов. Колонку раскладки задаёт экран прогона через CSS-переменные. */
export function useManagerLayout() {
  const [state, setState] = useState<{ width: number; collapsed: boolean }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as { width?: number; collapsed?: boolean };
      return { width: v.width && v.width >= MIN_W && v.width <= MAX_W ? v.width : DEFAULT_W, collapsed: Boolean(v.collapsed) };
    } catch {
      return { width: DEFAULT_W, collapsed: false };
    }
  });
  const save = (next: { width: number; collapsed: boolean }) => {
    setState(next);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {
      /* без памяти о раскладке */
    }
  };
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = state.width;
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.min(MAX_W, Math.max(MIN_W, w0 + ev.clientX - x0));
      setState((s) => ({ ...s, width: w }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-col-resizing', 'is-manager-resizing');
      save({ width: w, collapsed: false });
    };
    document.body.classList.add('is-col-resizing', 'is-manager-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return {
    collapsed: state.collapsed,
    setCollapsed: (collapsed: boolean) => save({ ...state, collapsed }),
    startResize,
    resetWidth: () => save({ width: DEFAULT_W, collapsed: false }),
    style: {
      '--manager-w': `${state.collapsed ? RAIL_W : state.width}px`,
      '--manager-h': state.collapsed ? `${RAIL_W}px` : '280px',
    } as CSSProperties,
  };
}

type Layout = ReturnType<typeof useManagerLayout>;

/** Чат с менеджером прогона: вопросы о ходе работы и поправки, которые человек применяет кнопкой. */
export function ManagerChat({ run, runId, layout }: { run: RunFile; runId: string; layout: Layout }) {
  const [messages, setMessages] = useState<ManagerMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    setMessages([]);
    setThinking(false);
    setError(null);
    void window.purpleflow.core
      .getManagerChat(runId)
      .then((c) => {
        if (!alive) return;
        setMessages(c.messages);
        setThinking(c.thinking);
      })
      .catch(() => {});
    const off = onCoreEvent((e) => {
      if (e.type !== 'manager.updated' || e.runId !== runId) return;
      setMessages(e.messages);
      setThinking(e.thinking);
    });
    return () => {
      alive = false;
      off();
    };
  }, [runId]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thinking]);

  // Поле растёт с текстом до пяти строк.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const send = async (t = text) => {
    const q = t.trim();
    if (!q || thinking) return;
    setText('');
    setError(null);
    setThinking(true);
    try {
      setMessages(await window.purpleflow.core.askManager(runId, q));
    } catch (e) {
      setText(q);
      setError(cleanErr(e));
    } finally {
      setThinking(false);
    }
  };

  const resolve = async (m: ManagerMessage, apply: boolean) => {
    setBusy(`${m.id}:${apply}`);
    setError(null);
    try {
      setMessages(await window.purpleflow.core.resolveManagerAction(runId, m.id, apply));
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };

  const pending = run.pending ?? [];
  const notes = pending.filter((p) => p.kind === 'note').length;
  const proposed = messages.some((m) => m.actionState === 'proposed');

  if (layout.collapsed) {
    return (
      <aside className="manager is-collapsed" aria-label="Менеджер прогона">
        <button className="manager-rail" onClick={() => layout.setCollapsed(false)} title="Развернуть чат с менеджером">
          <span className="manager-sign">
            <UserRoundCog size={15} />
          </span>
          {(thinking || proposed || pending.length > 0) && <i className={`manager-dot ${thinking ? 'is-thinking' : ''}`} aria-hidden />}
          <span className="manager-rail-label">Менеджер</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="manager" aria-label="Менеджер прогона">
      <div
        className="manager-resize"
        onPointerDown={layout.startResize}
        onDoubleClick={layout.resetWidth}
        title="Потяните, чтобы изменить ширину; двойной клик — по умолчанию"
      />
      <header className="manager-head">
        <span className="manager-sign" aria-hidden>
          <UserRoundCog size={15} />
        </span>
        <div>
          <strong>Менеджер</strong>
          <span>{thinking ? 'думает…' : 'спросите, как идут дела, или поправьте ход'}</span>
        </div>
        <button className="manager-collapse" onClick={() => layout.setCollapsed(true)} title="Свернуть чат" aria-label="Свернуть чат">
          <PanelLeftClose size={16} />
        </button>
      </header>

      {(notes > 0 || pending.some((p) => p.kind === 'pause')) && (
        <div className="manager-pending">
          {notes > 0 && (
            <span className="chip">
              <StickyNote size={12} /> {notes === 1 ? 'Заметка ждёт запуска агента' : `Заметок ждут агента: ${notes}`}
            </span>
          )}
          {pending.some((p) => p.kind === 'pause') && (
            <span className="chip">
              <Pause size={12} /> Пауза перед следующей стадией
            </span>
          )}
        </div>
      )}

      <div className="manager-list" ref={list}>
        {!messages.length && !thinking && (
          <div className="manager-empty">
            <p>
              Менеджер видит план, проверки, ревью и лог этого прогона. Он не меняет код сам — предлагает действие, а вы применяете его
              кнопкой.
            </p>
            <div className="manager-suggest">
              {SUGGEST.map((s) => (
                <button key={s} className="chip" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role} ${m.error ? 'is-error' : ''}`}>
            {m.role === 'user' ? <p>{m.text}</p> : <Markdown className="md msg-md" source={m.text} />}
            {m.result && m.result.output && <pre className="msg-output">{m.result.output}</pre>}
            {m.action && <ActionCard m={m} busy={busy} onResolve={resolve} />}
          </div>
        ))}
        {thinking && (
          <div className="msg msg-manager is-thinking" aria-label="Менеджер думает">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>

      {error && <p className="manager-error">{error}</p>}
      <form
        className="manager-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={run.status === 'finished' || run.status === 'cancelled' ? 'Спросить о прогоне' : 'Спросить или поправить…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="manager-send" disabled={!text.trim() || thinking} aria-label="Отправить">
          <ArrowUp size={15} />
        </button>
      </form>
    </aside>
  );
}

function ActionCard({
  m,
  busy,
  onResolve,
}: {
  m: ManagerMessage;
  busy: string | null;
  onResolve: (m: ManagerMessage, apply: boolean) => void;
}) {
  const a = m.action!;
  const def = ACTION[a.kind];
  const hint =
    a.kind === 'replan'
      ? a.keepCode === false
        ? 'Код откатится, снимок сохранится. План проверите вы'
        : 'Код останется. Новый план проверите вы'
      : a.kind === 'command'
        ? a.cwd === 'worktree'
          ? 'Выполнится в рабочей копии прогона'
          : 'Выполнится в папке проекта'
        : def.hint;
  return (
    <div className={`action-card is-${m.actionState ?? 'proposed'}`}>
      <div className="action-title">
        {def.icon}
        <strong>{def.title}</strong>
      </div>
      {'text' in a && <p className="action-text">{a.text}</p>}
      {a.kind === 'command' && <pre className="action-command">{a.command}</pre>}
      {m.actionState === 'proposed' ? (
        <>
          <p className="action-hint">{hint}</p>
          <div className="action-buttons">
            <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => onResolve(m, true)}>
              {busy === `${m.id}:true` ? <span className="spinner" aria-hidden /> : <Check size={14} />}
              <span>{a.kind === 'command' ? 'Выполнить' : 'Применить'}</span>
            </button>
            <button className="btn btn-quiet" disabled={Boolean(busy)} onClick={() => onResolve(m, false)}>
              <X size={14} />
              <span>Не надо</span>
            </button>
          </div>
        </>
      ) : (
        <p className="action-state">
          {m.actionState === 'applied' ? (a.kind === 'command' ? 'Выполнено' : 'Применено') : 'Не применялось'}
        </p>
      )}
    </div>
  );
}
