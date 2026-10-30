import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CircleAlert, FileCode2, Globe, PanelRightClose, RefreshCw } from 'lucide-react';
import type { ChatFile, DiffFile, ProjectConfig } from '@purpleflow/core';
import { BrowserPane, usePreview } from '../components/BrowserPane';
import { DiffReview } from '../components/DiffReview';
import { PillTabs } from '../components/PillTabs';
import { Button, Empty } from '../components/ui';
import { bridge, cleanErr } from '../lib/api';

export type ChatPane = 'code' | 'browser';

/** Изменённые файлы проекта чата — счётчик на кнопке «Код»; обновляется после каждого хода агента. */
export function useChatChanged(chat: ChatFile | null, busy: boolean): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);
  const id = chat?.id;
  const project = chat?.projectPath;
  const done = busy ? 'busy' : chat?.updatedAt;
  useEffect(() => {
    if (!id || !project) return setFiles(null);
    let alive = true;
    bridge.core
      .getChatChangedFiles(id)
      .then((f) => alive && setFiles(f))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, project, done]);
  return files;
}

const WIDTH_KEY = 'purpleflow.chatSideW';
const MIN_W = 380;

/** Ширина правой панели чата: тянется за ручку слева, запоминается для всех чатов. */
export function useSideWidth() {
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return v >= MIN_W ? v : 640;
    } catch {
      return 640;
    }
  });
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    let w = w0;
    // Чату слева оставляем не меньше 360 px.
    const max = Math.max(MIN_W, (e.currentTarget.closest('.chat-body')?.clientWidth ?? window.innerWidth) - 360);
    const move = (ev: PointerEvent) => {
      w = Math.min(max, Math.max(MIN_W, w0 - (ev.clientX - x0)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-col-resizing', 'is-side-resizing');
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
      } catch {
        /* без памяти о ширине */
      }
    };
    document.body.classList.add('is-col-resizing', 'is-side-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const reset = () => {
    setWidth(640);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* без памяти о ширине */
    }
  };
  return { width, startResize, reset };
}

/**
 * Правая панель чата — карточка со вкладками «Код» и «Браузер», как у прогона.
 * Обе вкладки остаются смонтированными — страница в браузере не перезагружается.
 */
export function ChatSide({
  chat,
  busy,
  pane,
  onPane,
  changed,
  width,
  onResize,
  onResetWidth,
}: {
  chat: ChatFile;
  busy: boolean;
  pane: ChatPane;
  onPane: (p: ChatPane | null) => void;
  changed: string[] | null;
  width: number;
  onResize: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResetWidth: () => void;
}) {
  const [cfg, setCfg] = useState<ProjectConfig | null>(null);
  const preview = usePreview(chat.id);
  useEffect(() => {
    if (chat.projectPath)
      bridge.core
        .getProjectConfig(chat.projectPath)
        .then(setCfg)
        .catch(() => {});
  }, [chat.projectPath]);
  const canRun = Boolean(cfg?.runCommand && cfg.appUrl);

  return (
    <section className="run-main chat-side" style={{ width }} aria-label="Код и браузер">
      <div
        className="side-resize"
        onPointerDown={onResize}
        onDoubleClick={onResetWidth}
        title="Потяните, чтобы изменить ширину; двойной клик — по умолчанию"
      />
      <div className="tab-groups">
        <PillTabs<ChatPane>
          className="tabs"
          value={pane}
          onChange={onPane}
          items={[
            ...(chat.projectPath
              ? [
                  {
                    id: 'code' as const,
                    label: 'Код',
                    extra: changed?.length ? <span className="tab-badge">{changed.length}</span> : undefined,
                  },
                ]
              : []),
            {
              id: 'browser',
              label: 'Браузер',
              extra:
                preview.state.status === 'ready' ? (
                  <span className="tab-dot is-ok" />
                ) : preview.state.status === 'starting' ? (
                  <span className="tab-live" />
                ) : undefined,
            },
          ]}
        />
        <span className="grow" />
        <button className="manager-collapse" title="Скрыть панель" aria-label="Скрыть панель" onClick={() => onPane(null)}>
          <PanelRightClose size={16} />
        </button>
      </div>
      <div className="chat-side-body" hidden={pane !== 'code'}>
        {chat.projectPath && <ChatCode chat={chat} busy={busy} />}
      </div>
      <div className="chat-side-body" hidden={pane !== 'browser'}>
        <BrowserPane
          preview={preview}
          canRun={canRun}
          manual
          intro={
            canRun
              ? 'Приложение поднимется из папки проекта на свободном порту и откроется прямо здесь.'
              : 'Откройте страницу своего локального сервера — проверьте, что поменял агент.'
          }
        />
      </div>
    </section>
  );
}

/** Свёрнутая панель — узкая полоса справа, как у чата менеджера слева. */
export function ChatSideRail({ chat, changed, onOpen }: { chat: ChatFile; changed: string[] | null; onOpen: (p: ChatPane) => void }) {
  return (
    <aside className="run-main chat-side is-collapsed" aria-label="Код и браузер">
      <button className="manager-rail" onClick={() => onOpen(chat.projectPath ? 'code' : 'browser')} title="Развернуть код и браузер">
        <span className="chat-rail-icons">
          {chat.projectPath && <FileCode2 size={15} />}
          <Globe size={15} />
        </span>
        {changed?.length ? <span className="chat-pane-count">{changed.length}</span> : null}
        <span className="manager-rail-label">{chat.projectPath ? 'Код и браузер' : 'Браузер'}</span>
      </button>
    </aside>
  );
}

const time = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Незакоммиченные изменения проекта: всё, что сделал агент (и вы), относительно последнего коммита. */
function ChatCode({ chat, busy }: { chat: ChatFile; busy: boolean }) {
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDiff(await bridge.core.getChatDiff(chat.id));
      setAt(new Date());
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setLoading(false);
    }
  };
  // Ход агента закончился — код мог поменяться.
  const done = busy ? 'busy' : chat.updatedAt;
  useEffect(() => {
    if (!busy) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, done]);

  return (
    <div className="chat-code">
      <div className="chat-code-bar">
        <span className="muted">Незакоммиченные изменения проекта{busy ? ' · агент работает, обновится после ответа' : ''}</span>
        <span className="grow" />
        {at && <span className="code-at">в {time(at)}</span>}
        <Button tone="quiet" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>
          Обновить
        </Button>
      </div>
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось получить дифф">
          {error}
        </Empty>
      ) : !diff ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : !diff.length ? (
        <Empty icon={<FileCode2 />} title="Изменений нет">
          Рабочая копия совпадает с последним коммитом. Попросите агента что-нибудь поправить — изменения появятся здесь.
        </Empty>
      ) : (
        <DiffReview
          files={diff}
          viewedKey={`chat:${chat.id}`}
          visualItems={[]}
          comments={[]}
          onComments={() => {}}
          readOnly
          tab="code"
          onTab={() => {}}
        />
      )}
    </div>
  );
}
