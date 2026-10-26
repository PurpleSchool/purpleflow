import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Clock, FilePen, FileText, FolderOpen, FolderPlus, ListTodo, Paperclip, Square, Trash2, Wrench, X } from 'lucide-react';
import type { AgentKind, ChatFile, ChatMessage, ChatPart, ProjectListItem } from '@psflow/core';
import { Markdown } from '../components/Markdown';
import { Button } from '../components/ui';
import { ComboInput, Select } from '../components/Dropdown';
import { MODEL_OPTIONS } from '../lib/models';
import { onCoreEvent, useStore } from '../lib/store';
import { shortPath } from '../lib/format';
import { cleanErr } from './run/util';
import { ChatSide, ChatSideRail, useChatChanged, useSideWidth, type ChatPane } from './ChatSide';


const SUGGEST_PROJECT = ['Как устроен этот проект?', 'Где обрабатываются ошибки API?', 'Найди и поправь опечатки в README'];
const SUGGEST_FREE = ['Объясни разницу между rebase и merge', 'Напиши регулярку для email', 'Набросай SQL-миграцию для таблицы заказов'];

const MAX_MB = 20;
const PANE_KEY = 'psflow.chatPane';
const isImage = (f: File) => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f.type);
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const shownName = (p: string) => baseName(p).replace(/^[a-z0-9]+-/, '');

interface Picked { id: string; file: File; url: string | null }

/** Чат с агентом вне конвейера: вопросы по проекту и небольшие правки без плана и ревью. */
export function ChatScreen({ chatId, initialProject }: { chatId?: string; initialProject?: string }) {
  const { state, go } = useStore();
  const settings = state.settings;
  const [chat, setChat] = useState<ChatFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(chatId));
  // Черновик нового чата: проект, агент, модель и правки до первого сообщения.
  const [draft, setDraft] = useState<{ projectPath?: string; agent: AgentKind; model: string; edits: boolean }>(() => ({
    projectPath: initialProject, agent: settings?.agents.executor ?? 'claude', model: '', edits: true,
  }));
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toTask, setToTask] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  // Правая панель: код или браузер; запоминается для всех чатов.
  const [pane, setPaneState] = useState<ChatPane | null>(() => {
    try {
      const v = localStorage.getItem(PANE_KEY);
      return v === 'code' || v === 'browser' ? v : null;
    } catch {
      return null;
    }
  });
  const setPane = (p: ChatPane | null) => {
    setPaneState(p);
    try {
      localStorage.setItem(PANE_KEY, p ?? '');
    } catch { /* без памяти о панели */ }
  };

  useEffect(() => {
    window.psflow.core.listProjects().then((p) => setProjects(p.filter((x) => x.exists))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    window.psflow.core.getChat(chatId).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r) {
        setChat(r.chat);
        setBusy(r.busy);
      } else setError('Чат не найден — возможно, его удалили.');
    }).catch((e) => setError(cleanErr(e)));
    const off = onCoreEvent((e) => {
      if (e.type === 'chat.updated' && e.chat.id === chatId) {
        setChat(e.chat);
        setBusy(e.busy);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [chatId]);

  // Лента держится у низа, пока человек сам не прокрутил вверх.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.messages, busy]);
  const onScroll = () => {
    const el = list.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Поле ввода растёт по тексту.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => input.current?.focus(), [chatId]);

  const addFiles = (list: FileList | File[]) => {
    const all = [...list];
    const big = all.filter((f) => f.size > MAX_MB * 1024 * 1024);
    setError(big.length ? `Файлы больше ${MAX_MB} МБ пропущены: ${big.map((f) => f.name).join(', ')}` : null);
    const ok = all.filter((f) => f.size <= MAX_MB * 1024 * 1024).map((f, i) => ({ id: `${Date.now()}-${i}`, file: f, url: isImage(f) ? URL.createObjectURL(f) : null }));
    setFiles((prev) => [...prev, ...ok]);
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (pasted.length) {
        e.preventDefault();
        addFiles(pasted);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const conf = chat ?? draft;
  const setConf = async (patch: Partial<Pick<ChatFile, 'agent' | 'model' | 'edits'>>) => {
    setError(null);
    if (!chat) return setDraft((d) => ({ ...d, ...patch, ...(patch.agent ? { model: '' } : {}) }));
    try {
      setChat(await window.psflow.core.updateChat(chat.id, { ...patch, ...(patch.agent ? { model: '' } : {}) }));
    } catch (e) {
      setError(cleanErr(e));
    }
  };

  const queued = Boolean(chat?.messages.some((m) => m.queued));

  const send = async (override?: string) => {
    const t = (override ?? text).trim();
    if (!t && !files.length) return;
    setError(null);
    stick.current = true;
    try {
      const attachments = await Promise.all(files.map(async (f) => ({ name: f.file.name || 'screenshot.png', data: new Uint8Array(await f.file.arrayBuffer()) })));
      let id = chat?.id;
      if (!id) {
        const created = await window.psflow.core.createChat(draft);
        id = created.id;
      }
      await window.psflow.core.sendChat(id, t, attachments);
      setText('');
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
      setFiles([]);
      if (!chat) go({ name: 'chat', chatId: id });
    } catch (e) {
      setError(cleanErr(e));
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const makeTask = async () => {
    if (!chat) return;
    setToTask(true);
    setError(null);
    try {
      const d = await window.psflow.core.chatToTask(chat.id);
      go({ name: 'new', project: d.projectPath || undefined, draft: d });
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setToTask(false);
    }
  };

  const remove = async () => {
    if (!chat) return;
    if (!confirmDelete) return setConfirmDelete(true);
    await window.psflow.core.deleteChat(chat.id);
    go({ name: 'chat' });
  };

  const pickProject = async (value: string) => {
    if (value === '__pick') {
      const dir = await window.psflow.pickFolder('Папка проекта для чата');
      if (dir) setDraft((d) => ({ ...d, projectPath: dir }));
      return;
    }
    setDraft((d) => ({ ...d, projectPath: value || undefined }));
  };

  const changed = useChatChanged(chat, busy);
  const side = useSideWidth();
  const messages = chat?.messages ?? [];
  const empty = !loading && messages.length === 0;
  const projectPath = chat ? chat.projectPath : draft.projectPath;
  const projectOptions = useMemo(() => {
    const paths = projects.map((p) => p.path);
    if (draft.projectPath && !paths.includes(draft.projectPath)) paths.unshift(draft.projectPath);
    return paths;
  }, [projects, draft.projectPath]);
  // Без проекта вкладки «Код» нет — остаётся браузер.
  const sidePane: ChatPane | null = pane === 'code' && !chat?.projectPath ? 'browser' : pane;
  const toolOk = (a: AgentKind) => Boolean(state.tools?.[a]?.path && !state.tools[a].error);

  return (
    <div className="screen chat-screen">
      <header className="chat-head">
        <div className="chat-head-title">
          {chat ? (
            <input
              className="chat-title"
              value={chat.title}
              aria-label="Название чата"
              onChange={(e) => setChat({ ...chat, title: e.target.value })}
              onBlur={(e) => void window.psflow.core.updateChat(chat.id, { title: e.target.value }).catch(() => {})}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : <h1 className="chat-title">Новый чат</h1>}
        </div>
        <div className="chat-head-actions">
          {chat ? (
            <span className="chat-project" title={projectPath ?? 'Чат без проекта: агент работает во временной папке чата'}>
              <FolderOpen size={14} /> <span>{projectPath ? baseName(projectPath) : 'Без проекта'}</span>
            </span>
          ) : (
            <Select<string>
              className="chat-project-pick"
              ariaLabel="Проект"
              icon={<FolderOpen size={14} />}
              value={draft.projectPath ?? ''}
              minWidth={320}
              onChange={(val) => void pickProject(val)}
              options={[
                { value: '', label: 'Без проекта', hint: 'Обычный чат, агент не видит код' },
                ...projectOptions.map((p) => ({ value: p, label: baseName(p), hint: shortPath(p) })),
                { value: '__pick', label: 'Выбрать папку…', icon: <FolderPlus size={14} /> },
              ]}
            />
          )}
          <div className="segmented small" role="radiogroup" aria-label="Агент">
            {(['claude', 'codex'] as AgentKind[]).map((a) => (
              <button key={a} role="radio" aria-checked={conf.agent === a} className={conf.agent === a ? 'is-on' : ''} disabled={busy} title={toolOk(a) ? undefined : `${a} не найден`} onClick={() => conf.agent !== a && void setConf({ agent: a })}>
                {a}
              </button>
            ))}
          </div>
          <ComboInput
            className="chat-model"
            ariaLabel="Модель"
            placeholder="модель по умолчанию"
            value={conf.model}
            disabled={busy}
            options={MODEL_OPTIONS[conf.agent]}
            onChange={(val) => (chat ? setChat({ ...chat, model: val }) : setDraft((d) => ({ ...d, model: val })))}
            onCommit={(val) => chat && val !== (chat.model ?? '') && void setConf({ model: val })}
          />
          <button
            role="switch"
            aria-checked={conf.edits}
            className={`switch chat-edits ${conf.edits ? 'is-on' : ''}`}
            disabled={busy}
            title={conf.edits ? 'Агент может менять файлы, когда вы просите' : 'Агент только читает файлы'}
            onClick={() => void setConf({ edits: !conf.edits })}
          >
            <i />
            <span>Правки</span>
          </button>
 {chat && (
            <>
              <span className="chat-head-end">
              <Button tone="ghost" icon={<ListTodo size={15} />} busy={toTask} disabled={busy || !messages.length} onClick={() => void makeTask()} title="Сформулировать задачу по переписке и открыть её в «Новой задаче»">
                Сделать задачей
              </Button>
              <Button
                tone={confirmDelete ? 'danger' : 'quiet'}
                icon={<Trash2 size={15} />}
                title="Удалить чат"
                onClick={() => void remove()}
                onBlur={() => confirmDelete && setTimeout(() => setConfirmDelete(false), 150)}
              >
                {confirmDelete ? 'Удалить?' : undefined}
              </Button>
              </span>
            </>
          )}
        </div>
      </header>

      <div className={`chat-body ${chat ? 'has-side' : ''}`}>
      <div className="chat-main">
      <div className="chat-list" ref={list} onScroll={onScroll}>
        <div className="chat-feed">
          {loading && <div className="center"><span className="spinner big" /></div>}
          {empty && (
            <div className="chat-empty">
              <h2>{projectPath ? `Спросите о ${baseName(projectPath)}` : 'О чём поговорим?'}</h2>
              <p>
                {projectPath
                  ? conf.edits
                    ? 'Агент видит проект и может вносить небольшие правки по вашей просьбе — без плана, ревью и приёмки. Для заметных изменений заведите задачу.'
                    : 'Агент видит проект, но только читает файлы.'
                  : 'Обычный чат с моделью. Выберите проект сверху, чтобы агент видел код.'}
              </p>
              <div className="chat-suggest">
                {(projectPath ? SUGGEST_PROJECT : SUGGEST_FREE).map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
              </div>
            </div>
          )}
          {messages.map((m) => m.role === 'user' ? <UserMessage key={m.id} m={m} chatId={chat!.id} /> : <AssistantMessage key={m.id} m={m} />)}
        </div>
      </div>

      <div className="chat-compose-wrap">
        {error && <p className="chat-error">{error}</p>}
        <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
          {files.length > 0 && (
            <div className="chat-files">
              {files.map((f) => (
                <span key={f.id} className="chat-file">
                  {f.url ? <img src={f.url} alt="" /> : <FileText size={14} />}
                  <span>{f.file.name || 'скриншот'}</span>
                  <button type="button" aria-label="Убрать" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="chat-compose-row">
            <button type="button" className="chat-attach" title="Прикрепить файлы или картинки (можно вставить из буфера)" onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <textarea
              ref={input}
              rows={1}
              value={text}
              placeholder={busy ? 'Агент отвечает — можно дописать уточнение, оно уйдёт следующим' : conf.edits && projectPath ? 'Спросите или попросите небольшую правку…' : 'Напишите сообщение…'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
            {busy && (
              <button type="button" className="chat-send is-stop" title={queued ? 'Остановить ответ — сообщения из очереди уйдут сразу' : 'Остановить ответ'} onClick={() => chat && void window.psflow.core.stopChat(chat.id)}><Square size={13} /></button>
            )}
            {(!busy || text.trim() || files.length > 0) && (
              <button type="submit" className="chat-send" disabled={!text.trim() && !files.length} aria-label={busy ? 'В очередь: уйдёт после ответа' : 'Отправить'} title={busy ? 'В очередь: уйдёт после ответа' : undefined}><ArrowUp size={16} /></button>
            )}
          </div>
        </form>
      </div>
      </div>
      {chat && !sidePane && <ChatSideRail chat={chat} changed={changed} onOpen={setPane} />}
      {chat && sidePane && <ChatSide chat={chat} busy={busy} pane={sidePane} onPane={setPane} changed={changed} width={side.width} onResize={side.startResize} onResetWidth={side.reset} />}
      </div>
    </div>
  );
}

function UserMessage({ m, chatId }: { m: ChatMessage; chatId: string }) {
  return (
    <div className={`chat-msg is-user ${m.queued ? 'is-queued' : ''}`}>
      {m.attachments?.length ? (
        <div className="chat-msg-files">
          {m.attachments.map((f) => (
            <button key={f} className="chat-file" title={f} onClick={() => void window.psflow.openPath(f)}>
              <FileText size={13} /><span>{shownName(f)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {m.text && <p>{m.text}</p>}
      {m.queued && (
        <div className="chat-queued">
          <Clock size={12} /><span>Уйдёт после ответа</span>
          <button type="button" onClick={() => void window.psflow.core.stopChat(chatId)} title="Остановить текущий ответ и сразу отправить это сообщение">Прервать и отправить</button>
          <button type="button" onClick={() => void window.psflow.core.unqueueChat(chatId, m.id)}>Убрать</button>
        </div>
      )}
    </div>
  );
}

/** Ответ: текст Markdown, вызовы инструментов — свёрнутыми строками между ним. */
function AssistantMessage({ m }: { m: ChatMessage }) {
  const parts = m.parts?.length ? m.parts : m.text ? [{ kind: 'text', text: m.text } as ChatPart] : [];
  // Подряд идущие инструменты — одной группой.
  const blocks: (ChatPart | { kind: 'tools'; items: string[] })[] = [];
  for (const p of parts) {
    const last = blocks[blocks.length - 1];
    if (p.kind === 'tool') {
      if (last && last.kind === 'tools') last.items.push(p.text);
      else blocks.push({ kind: 'tools', items: [p.text] });
    } else blocks.push(p);
  }
  return (
    <div className={`chat-msg is-assistant ${m.error ? 'is-error' : ''}`}>
      {blocks.map((b, i) => b.kind === 'tools' ? <ToolSteps key={i} items={b.items} live={Boolean(m.pending) && i === blocks.length - 1} /> : <Markdown key={i} className="md chat-md" source={(b as { text: string }).text} />)}
      {m.pending && (blocks.length === 0 || blocks[blocks.length - 1].kind === 'tools') && <div className="chat-typing" aria-label="Агент отвечает"><i /><i /><i /></div>}
      {m.changedFiles?.length ? (
        <div className="chat-changed">
          <FilePen size={13} />
          <span>Изменены: </span>
          {m.changedFiles.map((f) => <code key={f}>{f}</code>)}
        </div>
      ) : null}
      {m.stopped && <p className="chat-note">Ответ остановлен.</p>}
      {m.error && <p className="chat-msg-error">{cleanErr(m.error)}</p>}
    </div>
  );
}

function ToolSteps({ items, live }: { items: string[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(-1);
  return (
    <div className={`chat-tools ${live ? 'is-live' : ''}`}>
      <button className="chat-tools-head" onClick={() => setOpen(!open)}>
        <Wrench size={12} /> {items.length === 1 ? '1 действие' : `${items.length} ${items.length < 5 ? 'действия' : 'действий'}`}{open ? ' · скрыть' : items.length > 1 ? ' · показать все' : ''}
      </button>
      {shown.map((t, i) => <code key={i} className="chat-tool">{t}</code>)}
    </div>
  );
}
