import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp,
  Brain,
  Clock,
  Eye,
  FileText,
  FolderOpen,
  FolderPlus,
  ListTodo,
  Paperclip,
  Pencil,
  ShieldOff,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { AgentKind, ChatFile, ChatMessage, ProjectListItem } from '@purpleflow/core';
import { AssistantMessage } from './ChatAnswer';
import { useMentions } from './ChatMentions';
import { Button } from '../components/ui';
import { Select } from '../components/Dropdown';
import { AgentModelPicker } from '../components/AgentModelPicker';
import { useModelOptions } from '../lib/useModelOptions';
import { trialModelOf, trialOptions, useTrialLock } from '../lib/trial';
import { onCoreEvent, useStore } from '../lib/store';
import { shortPath } from '../lib/format';
import { enabledList } from '../lib/tools';
import { EFFORT_LEVELS, effortOf, effortOptions } from '../lib/effort';
import { ACCESS_OPTIONS, accessOf, accessPatch, type ChatAccess } from '../lib/chatAccess';
import { formatPick, insertPick, type PickedElement } from '../lib/pickElement';
import { PATH_DRAG, insertMention } from '../lib/mentions';
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
export function ChatScreen({ chatId, initialProject, initialText }: { chatId?: string; initialProject?: string; initialText?: string }) {
  const { state, go } = useStore();
  const settings = state.settings;
  const [chat, setChat] = useState<ChatFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(chatId));
  // Черновик нового чата: проект, агент, модель и правки до первого сообщения.
  const [draft, setDraft] = useState<{
    projectPath?: string;
    agent: AgentKind;
    model: string;
    effort?: string;
    edits: boolean;
    fullAccess?: boolean;
  }>(() => ({
    projectPath: initialProject,
    agent: settings?.agents.executor ?? 'claude',
    model: '',
    edits: true,
  }));
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [text, setText] = useState(initialText ?? '');
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
      return v === 'session' || v === 'files' || v === 'code' || v === 'git' || v === 'run' || v === 'browser' ? v : null;
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

  // Агент чата мог быть выключен в настройках — отвечает включённый, с моделью по умолчанию (так же решает ядро).
  const enabled = enabledList(settings?.enabledAgents);
  const raw = chat ?? draft;
  const conf = enabled.includes(raw.agent) ? raw : { ...raw, agent: enabled[0], model: '' };
  const access = accessOf(conf);
  const setConf = async (patch: Partial<Pick<ChatFile, 'agent' | 'model' | 'effort' | 'edits' | 'fullAccess'>>) => {
    setError(null);
    if (!chat) return setDraft((d) => ({ ...d, ...patch, ...(patch.agent && patch.model === undefined ? { model: '' } : {}) }));
    try {
      setChat(await bridge.core.updateChat(chat.id, { ...patch, ...(patch.agent && patch.model === undefined ? { model: '' } : {}) }));
    } catch (e) {
      setError(cleanErr(e));
    }
  };

  const queued = Boolean(chat?.messages.some((m) => m.queued));

  // Пробный режим PurpleSchool: прокси пускает только модели программы — у чата с другой моделью ставим пробную.
  const trial = useTrialLock();
  const trialPinned = trial ? (trialModelOf(conf.agent, trial)?.modelName ?? '') : '';
  const offTrial = Boolean(trial && conf.model && conf.model !== trialPinned);
  useEffect(() => {
    if (offTrial) void setConf({ model: trialPinned });
    // setConf пересоздаётся на каждый рендер; достаточно реагировать на смену модели и режима.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offTrial, trialPinned]);

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
  const modelOptions = useModelOptions(projectPath);
  const mention = useMentions({ text, setText, input, projectPath });

  /** Элемент, указанный во вкладке «Браузер»: описание — в поле ввода, курсор — после него, чтобы дописать просьбу. */
  const mentionPath = (rel: string) => {
    const el = input.current;
    const r = insertMention(text, el && document.activeElement === el ? el.selectionStart : text.length, rel);
    setText(r.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  };
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
  const sidePane: ChatPane | null =
    (pane === 'files' || pane === 'code' || pane === 'git' || pane === 'run') && !chat?.projectPath ? 'browser' : pane;
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
                      ? access === 'full'
                        ? 'Агент видит проект и работает без песочницы: правки, коммиты, процессы — по вашей просьбе, без плана, ревью и приёмки.'
                        : access === 'edits'
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
                  <AssistantMessage
                    key={m.id}
                    m={m}
                    answerable={i > lastUser}
                    onAnswer={(t) => void send(t)}
                    onAllowMcp={(t, always) =>
                      chat && void bridge.core.allowChatMcp(chat.id, { ...t, always }).catch((e) => setError(cleanErr(e)))
                    }
                    onGrantFull={
                      access === 'edits' && chat
                        ? () => void bridge.core.grantChatFullAccess(chat.id).catch((e) => setError(cleanErr(e)))
                        : undefined
                    }
                  />
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
                // Файл или папка из вкладки «Файлы» — упоминание, а не вложение.
                const rel = e.dataTransfer.getData(PATH_DRAG);
                if (rel) mentionPath(rel);
                else if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
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
                <Select<ChatAccess>
                  className={`chat-mode is-${access}`}
                  ariaLabel="Режим"
                  title="Что агенту можно в этом чате"
                  icon={access === 'read' ? <Eye size={14} /> : access === 'edits' ? <Pencil size={14} /> : <ShieldOff size={14} />}
                  value={access}
                  minWidth={300}
                  disabled={busy}
                  onChange={(a) => a !== access && void setConf(accessPatch(a))}
                  options={ACCESS_OPTIONS}
                />
                <AgentModelPicker
                  agents={enabled}
                  agent={conf.agent}
                  model={conf.model}
                  fallback={fallbackModel}
                  options={trial ? trialOptions(enabled, trial) : modelOptions}
                  noCustom={Boolean(trial)}
                  missing={(a) => !toolOk(a)}
                  disabled={busy}
                  onPick={(agent, model) => void setConf(agent === conf.agent ? { model } : { agent, model })}
                />
                {EFFORT_LEVELS[conf.agent].length > 0 && (
                  <Select<string>
                    className={`chat-effort${effortOf(conf.agent, conf.effort) ? '' : ' is-default'}`}
                    ariaLabel="Уровень рассуждений"
                    title="Уровень рассуждений (effort): выше — дольше и дороже, но тщательнее"
                    icon={<Brain size={14} />}
                    value={effortOf(conf.agent, conf.effort)}
                    minWidth={280}
                    disabled={busy}
                    onChange={(effort) => void setConf({ effort })}
                    options={effortOptions(conf.agent)}
                  />
                )}
                <span className="chat-compose-end">
                  {busy && (
                    <button
                      type="button"
                      className="chat-send is-stop"
                      title={queued ? 'Остановить ответ — сообщения из очереди уйдут сразу' : 'Остановить ответ'}
                      onClick={() => chat && bridge.core.stopChat(chat.id).catch(() => {})}
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
            onMention={mentionPath}
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
            onClick={() => void bridge.core.stopChat(chatId).catch(() => {})}
            title="Остановить текущий ответ и сразу отправить это сообщение"
          >
            Прервать и отправить
          </button>
          <button type="button" onClick={() => void bridge.core.unqueueChat(chatId, m.id).catch(() => {})}>
            Убрать
          </button>
        </div>
      )}
    </div>
  );
}
