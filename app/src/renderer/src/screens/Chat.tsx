import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Clock, FileText, FolderOpen, FolderPlus, ListTodo, Paperclip, Square, Trash2, X } from 'lucide-react';
import type { AgentKind, ChatFile, ChatMessage, ProjectListItem } from '@purpleflow/core';
import { AssistantMessage } from './ChatAnswer';
import { useMentions } from './ChatMentions';
import { Button } from '../components/ui';
import { ComboInput, Select } from '../components/Dropdown';
import { useModelOptions } from '../lib/useModelOptions';
import { onCoreEvent, useStore } from '../lib/store';
import { shortPath } from '../lib/format';
import { formatPick, insertPick, type PickedElement } from '../lib/pickElement';
import { ChatSide, ChatSideRail, useChatChanged, useSideWidth, type ChatPane } from './ChatSide';
import { bridge, cleanErr } from '../lib/api';

const SUGGEST_PROJECT = ['Как устроен этот проект?', 'Где обрабатываются ошибки API?', 'Найди и поправь опечатки в README'];
const SUGGEST_FREE = ['Объясни разницу между rebase и merge', 'Напиши регулярку для email', 'Набросай SQL-миграцию для таблицы заказов'];

const MAX_MB = 20;
const PANE_KEY = 'purpleflow.chatPane';
const isImage = (f: File) => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f.type);
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const shownName = (p: string) => baseName(p).replace(/^[a-z0-9]+-/, '');

interface Picked {
  id: string;
  file: File;
  url: string | null;
}

/** Чат с агентом вне конвейера: вопросы по проекту и небольшие правки без плана и ревью. */
export function ChatScreen({ chatId, initialProject }: { chatId?: string; initialProject?: string }) {
  const modelOptions = useModelOptions();
  const { state, go } = useStore();
  const settings = state.settings;
  const [chat, setChat] = useState<ChatFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(chatId));
  // Черновик нового чата: проект, агент, модель и правки до первого сообщения.
  const [draft, setDraft] = useState<{ projectPath?: string; agent: AgentKind; model: string; edits: boolean }>(() => ({
    projectPath: initialProject,
    agent: settings?.agents.executor ?? 'claude',
    model: '',
    edits: true,
  }));
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Что человек набирает в заголовке: события ответа агента приходят постоянно и иначе затирали бы ввод. */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
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
      return v === 'session' || v === 'code' || v === 'run' || v === 'browser' ? v : null;
    } catch {
      return null;
    }
  });
  const setPane = (p: ChatPane | null) => {
    setPaneState(p);
    try {
      localStorage.setItem(PANE_KEY, p ?? '');
    } catch {
      /* без памяти о панели */
    }
  };

  useEffect(() => {
    bridge.core
      .listProjects()
      .then((p) => setProjects(p.filter((x) => x.exists)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    bridge.core
      .getChat(chatId)
      .then((r) => {
        if (!alive) return;
        setLoading(false);
        if (r) {
          setChat(r.chat);
          setBusy(r.busy);
        } else setError('Чат не найден — возможно, его удалили.');
      })
      .catch((e) => setError(cleanErr(e)));
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
    const ok = all
      .filter((f) => f.size <= MAX_MB * 1024 * 1024)
      .map((f, i) => ({ id: `${Date.now()}-${i}`, file: f, url: isImage(f) ? URL.createObjectURL(f) : null }));
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
      setChat(await bridge.core.updateChat(chat.id, { ...patch, ...(patch.agent ? { model: '' } : {}) }));
    } catch (e) {
      setError(cleanErr(e));
    }
  };

  const queued = Boolean(chat?.messages.some((m) => m.queued));

  // Модель по умолчанию — из настроек ролей; поле показывает её, даже когда у чата своей модели нет.
  const [defaultModel, setDefaultModel] = useState<{ agent: AgentKind; model: string } | null>(null);
  useEffect(() => {
    let alive = true;
    bridge.core
      .chatDefaultModel(conf.agent)
      .then((model) => alive && setDefaultModel({ agent: conf.agent, model }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [conf.agent, settings?.models, settings?.agents]);
  // В настройках пусто — модель выбирает CLI; если он уже отвечал этим агентом, показываем, какую выбрал.
  const lastModel =
    chat?.session?.agent === conf.agent ? [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model : undefined;
  const fallbackModel = (defaultModel?.agent === conf.agent ? defaultModel.model : '') || lastModel || '';
  const shownModel = conf.model || fallbackModel;

  /** Текст очищается только после ответа ядра — без этого двойной Enter отправил бы сообщение дважды. */
  const sending = useRef(false);
  const send = async (override?: string) => {
    const t = (override ?? text).trim();
    if ((!t && !files.length) || sending.current) return;
    sending.current = true;
    setError(null);
    stick.current = true;
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({ name: f.file.name || 'screenshot.png', data: new Uint8Array(await f.file.arrayBuffer()) })),
      );
      let id = chat?.id;
      if (!id) {
        const created = await bridge.core.createChat(draft);
        id = created.id;
      }
      await bridge.core.sendChat(id, t, attachments);
      setText('');
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
      setFiles([]);
      if (!chat) go({ name: 'chat', chatId: id });
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      sending.current = false;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.onKeyDown(e)) return;
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
      const d = await bridge.core.chatToTask(chat.id);
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
    await bridge.core.deleteChat(chat.id).catch((e) => setError(cleanErr(e)));
    go({ name: 'chat' });
  };

  const pickProject = async (value: string) => {
    if (value === '__pick') {
      const dir = await bridge.pickFolder('Папка проекта для чата');
      if (dir) setDraft((d) => ({ ...d, projectPath: dir }));
      return;
    }
    setDraft((d) => ({ ...d, projectPath: value || undefined }));
  };

  const changed = useChatChanged(chat, busy);
  const side = useSideWidth();
  const messages = chat?.messages ?? [];
  // На вопросы агента отвечают, пока после них нет сообщения человека.
  const lastUser = messages.reduce((at, m, i) => (m.role === 'user' ? i : at), -1);
  const empty = !loading && messages.length === 0;
  const projectPath = chat ? chat.projectPath : draft.projectPath;
  const mention = useMentions({ text, setText, input, projectPath });

  /** Элемент, указанный во вкладке «Браузер»: описание — в поле ввода, курсор — после него, чтобы дописать просьбу. */
  const onPick = (el: PickedElement) => {
    setText((t) => insertPick(t, formatPick(el)));
    requestAnimationFrame(() => {
      const box = input.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.scrollTop = box.scrollHeight;
    });
  };
  const projectOptions = useMemo(() => {
    const paths = projects.map((p) => p.path);
    if (draft.projectPath && !paths.includes(draft.projectPath)) paths.unshift(draft.projectPath);
    return paths;
  }, [projects, draft.projectPath]);
  // Без проекта вкладок «Код» и «Запуск» нет — остаётся браузер.
  const sidePane: ChatPane | null = (pane === 'code' || pane === 'run') && !chat?.projectPath ? 'browser' : pane;
  const toolOk = (a: AgentKind) => Boolean(state.tools?.[a]?.path && !state.tools[a].error);

  return (
    <div className="screen chat-screen">
      <header className="chat-head">
        <div className="chat-head-title">
          {chat ? (
            <input
              className="chat-title"
              value={titleDraft ?? chat.title}
              aria-label="Название чата"
              onFocus={() => setTitleDraft(chat.title)}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={(e) => {
                const title = e.target.value;
                setTitleDraft(null);
                setChat({ ...chat, title });
                bridge.core.updateChat(chat.id, { title }).catch((err) => setError(cleanErr(err)));
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <h1 className="chat-title">Новый чат</h1>
          )}
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
          {chat && (
            <>
              <span className="chat-head-end">
                <Button
                  tone="ghost"
                  icon={<ListTodo size={15} />}
                  busy={toTask}
                  disabled={busy || !messages.length}
                  onClick={() => void makeTask()}
                  title="Сформулировать задачу по переписке и открыть её в «Новой задаче»"
                >
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
              {loading && (
                <div className="center">
                  <span className="spinner big" />
                </div>
              )}
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
                    {(projectPath ? SUGGEST_PROJECT : SUGGEST_FREE).map((s) => (
                      <button key={s} className="chip" onClick={() => void send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <UserMessage key={m.id} m={m} chatId={chat!.id} />
                ) : (
                  <AssistantMessage key={m.id} m={m} answerable={i > lastUser} onAnswer={(t) => void send(t)} />
                ),
              )}
            </div>
          </div>

          <div className="chat-compose-wrap">
            {error && <p className="chat-error">{error}</p>}
            <form
              className="chat-compose"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
              }}
            >
              {mention.menu}
              {files.length > 0 && (
                <div className="chat-files">
                  {files.map((f) => (
                    <span key={f.id} className="chat-file">
                      {f.url ? <img src={f.url} alt="" /> : <FileText size={14} />}
                      <span>{f.file.name || 'скриншот'}</span>
                      <button type="button" aria-label="Убрать" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="chat-compose-row">
                <textarea
                  ref={input}
                  rows={1}
                  value={text}
                  placeholder={
                    busy
                      ? 'Агент отвечает — можно дописать уточнение, оно уйдёт следующим'
                      : conf.edits && projectPath
                        ? 'Спросите или попросите правку… @ — файл, / — скилл'
                        : projectPath
                          ? 'Напишите сообщение… @ — файл, / — скилл'
                          : 'Напишите сообщение… / — скилл'
                  }
                  onChange={(e) => {
                    setText(e.target.value);
                    mention.onInput();
                  }}
                  onSelect={mention.onCaret}
                  onKeyDown={onKey}
                />
              </div>
              <div className="chat-compose-bar">
                <button
                  type="button"
                  className="chat-attach"
                  title="Прикрепить файлы или картинки (можно вставить из буфера)"
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip size={16} />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <div className="segmented chat-mode" role="radiogroup" aria-label="Режим">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!conf.edits}
                    className={!conf.edits ? 'is-on' : ''}
                    disabled={busy}
                    title="Агент только читает файлы и отвечает"
                    onClick={() => conf.edits && void setConf({ edits: false })}
                  >
                    Вопросы
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={conf.edits}
                    className={conf.edits ? 'is-on' : ''}
                    disabled={busy}
                    title="Агент может менять файлы, когда вы просите"
                    onClick={() => !conf.edits && void setConf({ edits: true })}
                  >
                    Правки
                  </button>
                </div>
                <div className="segmented chat-agent" role="radiogroup" aria-label="Агент">
                  {(['claude', 'codex'] as AgentKind[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={conf.agent === a}
                      className={conf.agent === a ? 'is-on' : ''}
                      disabled={busy}
                      title={toolOk(a) ? undefined : `${a} не найден`}
                      onClick={() => conf.agent !== a && void setConf({ agent: a })}
                    >
                      {a}
                    </button>
                  ))}
                </div>
                <ComboInput
                  ariaLabel="Модель"
                  className={`chat-model ${conf.model ? '' : 'is-default'}`}
                  placeholder={fallbackModel || 'по умолчанию'}
                  value={conf.model}
                  disabled={busy}
                  options={modelOptions[conf.agent]}
                  onChange={(val) => (chat ? setChat({ ...chat, model: val }) : setDraft((d) => ({ ...d, model: val })))}
                  onCommit={(val) => chat && val !== (chat.model ?? '') && void setConf({ model: val })}
                />
                <span className="chat-compose-end">
                  {busy && (
                    <button
                      type="button"
                      className="chat-send is-stop"
                      title={queued ? 'Остановить ответ — сообщения из очереди уйдут сразу' : 'Остановить ответ'}
                      onClick={() => chat && bridge.core.stopChat(chat.id).catch((e) => setError(cleanErr(e)))}
                    >
                      <Square size={13} />
                    </button>
                  )}
                  {(!busy || text.trim() || files.length > 0) && (
                    <button
                      type="submit"
                      className="chat-send"
                      disabled={!text.trim() && !files.length}
                      aria-label={busy ? 'В очередь: уйдёт после ответа' : 'Отправить'}
                      title={busy ? 'В очередь: уйдёт после ответа' : undefined}
                    >
                      <ArrowUp size={16} />
                    </button>
                  )}
                </span>
              </div>
            </form>
          </div>
        </div>
        {chat && !sidePane && <ChatSideRail chat={chat} changed={changed} onOpen={setPane} />}
        {chat && sidePane && (
          <ChatSide
            chat={chat}
            busy={busy}
            pane={sidePane}
            model={shownModel}
            onPick={onPick}
            onPane={setPane}
            changed={changed}
            width={side.width}
            onResize={side.startResize}
            onResetWidth={side.reset}
          />
        )}
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
            <button key={f} className="chat-file" title={f} onClick={() => void bridge.openPath(f)}>
              <FileText size={13} />
              <span>{shownName(f)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {m.text && <p>{m.text}</p>}
      {m.queued && (
        <div className="chat-queued">
          <Clock size={12} />
          <span>Уйдёт после ответа</span>
          <button
            type="button"
            onClick={() => void bridge.core.stopChat(chatId)}
            title="Остановить текущий ответ и сразу отправить это сообщение"
          >
            Прервать и отправить
          </button>
          <button type="button" onClick={() => void bridge.core.unqueueChat(chatId, m.id)}>
            Убрать
          </button>
        </div>
      )}
    </div>
  );
}
