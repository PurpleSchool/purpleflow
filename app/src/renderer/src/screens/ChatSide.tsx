import { useEffect, useState } from 'react';
import { CircleAlert, FileCode2, RefreshCw } from 'lucide-react';
import type { ChatFile, DiffFile, ProjectConfig } from '@psflow/core';
import { BrowserPane, usePreview } from '../components/BrowserPane';
import { DiffReview } from '../components/DiffReview';
import { Button, Empty } from '../components/ui';
import { cleanErr } from './run/util';

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
    window.psflow.core.getChatChangedFiles(id).then((f) => alive && setFiles(f)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, project, done]);
  return files;
}

/** Правая панель чата: дифф проекта и браузер. Оба остаются смонтированными — страница в браузере не перезагружается. */
export function ChatSide({ chat, busy, pane }: { chat: ChatFile; busy: boolean; pane: ChatPane }) {
  const [cfg, setCfg] = useState<ProjectConfig | null>(null);
  const preview = usePreview(chat.id);
  useEffect(() => {
    if (chat.projectPath) window.psflow.core.getProjectConfig(chat.projectPath).then(setCfg).catch(() => {});
  }, [chat.projectPath]);
  const canRun = Boolean(cfg?.runCommand && cfg.appUrl);

  return (
    <aside className="chat-side" aria-label="Код и браузер">
      <div className="chat-side-body" hidden={pane !== 'code'}>
        {chat.projectPath && <ChatCode chat={chat} busy={busy} />}
      </div>
      <div className="chat-side-body" hidden={pane !== 'browser'}>
        <BrowserPane
          preview={preview}
          canRun={canRun}
          manual
          intro={canRun ? 'Приложение поднимется из папки проекта на свободном порту и откроется прямо здесь.' : 'Откройте страницу своего локального сервера — проверьте, что поменял агент.'}
        />
      </div>
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
      setDiff(await window.psflow.core.getChatDiff(chat.id));
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
        <Button tone="quiet" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>Обновить</Button>
      </div>
      {error ? <Empty icon={<CircleAlert />} title="Не удалось получить дифф">{error}</Empty>
        : !diff ? <div className="center"><span className="spinner big" /></div>
        : !diff.length ? <Empty icon={<FileCode2 />} title="Изменений нет">Рабочая копия совпадает с последним коммитом. Попросите агента что-нибудь поправить — изменения появятся здесь.</Empty>
        : <DiffReview files={diff} viewedKey={`chat:${chat.id}`} visualItems={[]} comments={[]} onComments={() => {}} readOnly tab="code" onTab={() => {}} />}
    </div>
  );
}

