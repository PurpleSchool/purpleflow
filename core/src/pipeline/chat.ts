import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emptyUsage, type AgentResult, type AgentStep } from '../agents/common.js';
import { Git } from '../git.js';
import { killGroup } from '../proc.js';
import { isImageFile } from '../shared.js';
import { writeAtomic } from '../store.js';
import type { AgentKind, ChatFile, ChatMessage, ChatPart, ChatSummary, DiffFile, NextPartDraft, PreviewState } from '../types.js';
import type { Orchestrator } from '../orchestrator.js';

/**
 * Чат — обычный разговор с claude или codex вне конвейера: вопросы по проекту и небольшие правки,
 * которым не нужны план, ревью и приёмка. Каждый ход — запуск CLI, контекст держит его сессия.
 */

/** Сколько последних сообщений пересказать, если сессии CLI нет (сменили агента). */
const HISTORY = 12;
/** Как часто отправлять в окно ответ, который ещё пишется. */
const FLUSH_MS = 120;

const chatsDir = (h: Orchestrator) => path.join(h.opts.dataDir, 'chats');
const chatFile = (h: Orchestrator, id: string) => path.join(chatsDir(h), `${id}.json`);
/** Вложения и рабочая папка чата без проекта. */
const chatFilesDir = (h: Orchestrator, id: string) => path.join(chatsDir(h), id);
const group = (id: string) => `chat:${id}`;

/** Чат, по которому идёт ход: одна копия в памяти, чтобы сообщения в очередь и правки настроек не затирались сохранениями хода. */
const live = new WeakMap<Orchestrator, Map<string, ChatFile>>();
const liveOf = (h: Orchestrator) => {
  let m = live.get(h);
  if (!m) live.set(h, (m = new Map()));
  return m;
};

function read(h: Orchestrator, id: string): ChatFile | null {
  const cur = liveOf(h).get(id);
  if (cur) return cur;
  try {
    const chat = JSON.parse(fs.readFileSync(chatFile(h, id), 'utf8')) as ChatFile;
    // Ответ, который писался при закрытии приложения, уже не допишется.
    if (!h.chatBusy.has(id)) for (const m of chat.messages) if (m.pending) Object.assign(m, { pending: false, stopped: true });
    return chat;
  } catch {
    return null;
  }
}

function must(h: Orchestrator, id: string): ChatFile {
  const c = read(h, id);
  if (!c) throw new Error('Чат не найден');
  return c;
}

/** Удалённые чаты: ход, который ещё доигрывает, не должен воскресить файл. */
const deleted = new Set<string>();

function save(h: Orchestrator, chat: ChatFile) {
  if (deleted.has(chat.id)) return;
  chat.updatedAt = new Date().toISOString();
  writeAtomic(chatFile(h, chat.id), JSON.stringify(chat, null, 2));
  h.emit({ type: 'chat.updated', chat: structuredClone(chat), busy: h.chatBusy.has(chat.id) });
}

/** Строка чата в истории: last — итог последнего ответа агента. */
export function chatSummary(c: ChatFile, busy: boolean): ChatSummary {
  const answer = [...c.messages].reverse().find((m) => m.role === 'assistant' && !m.pending);
  const last = answer ? (answer.error || answer.stopped ? 'error' : 'ok') : null;
  return { id: c.id, title: c.title, projectPath: c.projectPath, agent: c.agent, updatedAt: c.updatedAt, busy, last };
}

export function listChats(h: Orchestrator): ChatSummary[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(chatsDir(h)).filter((f) => f.endsWith('.json'));
  } catch { /* чатов ещё нет */ }
  return files
    .map((f) => read(h, f.slice(0, -5)))
    .filter((c): c is ChatFile => Boolean(c))
    .map((c) => chatSummary(c, h.chatBusy.has(c.id)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getChat(h: Orchestrator, id: string): { chat: ChatFile; busy: boolean } | null {
  const chat = read(h, id);
  return chat ? { chat, busy: h.chatBusy.has(id) } : null;
}

export async function createChat(h: Orchestrator, o: { projectPath?: string; agent?: AgentKind; model?: string; edits?: boolean }): Promise<ChatFile> {
  const now = new Date().toISOString();
  const agent = o.agent ?? (await h.serviceAgent());
  const projectPath = o.projectPath?.trim() || undefined;
  if (projectPath && !fs.existsSync(projectPath)) throw new Error('Папка проекта не найдена');
  const chat: ChatFile = {
    id: `chat-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    title: 'Новый чат', projectPath, agent, model: o.model ?? '', edits: o.edits ?? true,
    createdAt: now, updatedAt: now, messages: [],
  };
  fs.mkdirSync(chatsDir(h), { recursive: true });
  save(h, chat);
  return chat;
}

/** Название, агент, модель и правки. Смена агента начинает новую сессию — история уйдёт пересказом. */
export function updateChat(h: Orchestrator, id: string, patch: Partial<Pick<ChatFile, 'title' | 'agent' | 'model' | 'edits'>>): ChatFile {
  const chat = must(h, id);
  if (patch.title !== undefined) chat.title = patch.title.trim().slice(0, 120) || chat.title;
  if (patch.agent && patch.agent !== chat.agent) chat.agent = patch.agent;
  if (patch.model !== undefined) chat.model = patch.model.trim();
  if (patch.edits !== undefined) chat.edits = patch.edits;
  save(h, chat);
  return chat;
}

export async function deleteChat(h: Orchestrator, id: string): Promise<void> {
  deleted.add(id);
  liveOf(h).delete(id);
  await killGroup(group(id));
  await h.stopPreview(id);
  h.chatBusy.delete(id);
  fs.rmSync(chatFile(h, id), { force: true });
  fs.rmSync(chatFilesDir(h, id), { recursive: true, force: true });
  h.emit({ type: 'chat.deleted', chatId: id });
}

export async function stopChat(h: Orchestrator, id: string): Promise<void> {
  await killGroup(group(id));
}

/** Изменённые файлы рабочей копии с временем изменения — сравнить до и после хода. */
async function snapshot(git: Git, dir: string): Promise<Map<string, number>> {
  const files = await git.dirtyFiles(dir).catch(() => [] as string[]);
  const out = new Map<string, number>();
  for (const f of files) {
    const p = f.replace(/^"|"$/g, '').split(' -> ').pop()!;
    let t = -1;
    try {
      t = fs.statSync(path.join(dir, p)).mtimeMs;
    } catch { /* удалён */ }
    out.set(p, t);
  }
  return out;
}

function systemPrompt(h: Orchestrator, chat: ChatFile, cwd: string): string {
  const where = chat.projectPath
    ? `Ты работаешь в проекте ${chat.projectPath} — это рабочая папка.`
    : `Проекта нет: рабочая папка ${cwd} — временная папка этого чата.`;
  const rules = chat.edits
    ? 'Тебе можно менять файлы, но только когда человек об этом просит. Это небольшие задачи без плана и ревью: делай ровно то, что попросили, не трогай лишнего и не делай коммитов. В конце коротко перечисли, что изменил.'
    : 'Режим только чтения: файлы не меняй, команды, которые что-то меняют, не запускай. Если нужна правка — предложи её текстом или посоветуй завести задачу в PurpleFlow.';
  let s = `Ты — ассистент в чате PurpleFlow. ${where} ${rules} Отвечай по-русски, по делу, в Markdown.`;
  if (chat.projectPath) {
    const k = h.knowledgeOf(chat.projectPath);
    const lessons = k.lessons?.map((l) => `- ${l.text}`).join('\n');
    if (k.profile) s += `\n\n## Профиль проекта\n\n${k.profile.trim()}`;
    if (lessons) s += `\n\n## Уроки прошлых прогонов\n\n${lessons}`;
  }
  return s;
}

/** Без сессии CLI (первый ход на этом агенте) — пересказ последних сообщений. */
function historyBlock(messages: ChatMessage[]): string {
  const prev = messages.filter((m) => !m.pending && (m.text.trim() || m.error)).slice(-HISTORY);
  if (!prev.length) return '';
  const lines = prev.map((m) => `${m.role === 'user' ? 'Человек' : 'Ассистент'}: ${m.text.trim().slice(0, 4000) || '(без ответа)'}`);
  return `Предыдущая переписка в этом чате:\n\n${lines.join('\n\n')}\n\n---\n\n`;
}

const saveAttachments = (h: Orchestrator, id: string, files: { name: string; data: Uint8Array }[]): string[] => {
  if (!files.length) return [];
  const dir = path.join(chatFilesDir(h, id), 'files');
  fs.mkdirSync(dir, { recursive: true });
  return files.map((f) => {
    const ext = path.extname(f.name).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const base = path.basename(f.name, path.extname(f.name)).replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 60) || 'file';
    const file = path.join(dir, `${Date.now().toString(36)}-${base}${ext}`);
    fs.writeFileSync(file, Buffer.from(f.data));
    return file;
  });
};

/**
 * Сообщение человека. Если агент свободен — сразу ход; если отвечает — сообщение встаёт в очередь
 * и уходит следующим ходом (все накопленные — одним). «Прервать и отправить» — это stopChat: ход обрывается, очередь уходит.
 */
export async function sendChat(h: Orchestrator, id: string, text: string, files: { name: string; data: Uint8Array }[] = []): Promise<void> {
  if (!text.trim() && !files.length) throw new Error('Пустое сообщение');
  const chat = must(h, id);
  const attachments = saveAttachments(h, id, files);
  chat.messages.push({ id: crypto.randomUUID(), role: 'user', at: new Date().toISOString(), text: text.trim(), attachments: attachments.length ? attachments : undefined, queued: true });
  if (chat.title === 'Новый чат' && text.trim()) chat.title = text.trim().replace(/\s+/g, ' ').slice(0, 60);
  save(h, chat);
  if (h.chatBusy.has(id)) return;
  h.chatBusy.add(id);
  liveOf(h).set(id, chat);
  try {
    // Пока есть очередь — ход за ходом: сообщения, присланные во время ответа, уходят следующим ходом.
    for (;;) {
      const batch = chat.messages.filter((m) => m.queued);
      if (!batch.length || !liveOf(h).has(id)) break;
      await turn(h, chat, batch);
    }
  } finally {
    h.chatBusy.delete(id);
    if (liveOf(h).get(id) === chat) {
      liveOf(h).delete(id);
      save(h, chat);
    }
  }
}

/** Убрать сообщение из очереди, пока оно не ушло агенту. */
export function unqueueChat(h: Orchestrator, id: string, messageId: string): ChatFile {
  const chat = must(h, id);
  const m = chat.messages.find((x) => x.id === messageId);
  if (!m?.queued) throw new Error('Сообщение уже ушло агенту');
  chat.messages = chat.messages.filter((x) => x.id !== messageId);
  save(h, chat);
  return chat;
}

/** Один ход: сообщения человека из очереди и ответ агента. Ответ приходит событиями chat.updated по мере генерации. */
async function turn(h: Orchestrator, chat: ChatFile, batch: ChatMessage[]): Promise<void> {
  const id = chat.id;
  const first = chat.messages.indexOf(batch[0]);
  const prevMessages = chat.messages.slice(0, first).filter((m) => !m.queued);
  for (const m of batch) m.queued = undefined;
  // Сообщения из очереди встают перед ответом, даже если пришли, пока писался прошлый.
  chat.messages = [...chat.messages.filter((m) => !batch.includes(m)), ...batch];
  const attachments = batch.flatMap((m) => m.attachments ?? []);
  const lastAnswer = [...prevMessages].reverse().find((m) => m.role === 'assistant');
  const said = batch.map((m) => m.text.trim()).filter(Boolean).join('\n\n');
  const text = (lastAnswer?.stopped ? 'Я прервал твой предыдущий ответ.\n\n' : '') + said;
  const at = () => new Date().toISOString();
  const answer: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', at: at(), text: '', parts: [], pending: true };
  chat.messages.push(answer);
  save(h, chat);

  // Шаги ответа копятся здесь и уходят в окно не чаще FLUSH_MS.
  const parts: ChatPart[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    answer.parts = parts.map((p) => ({ ...p }));
    answer.text = parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n\n');
    save(h, chat);
  };
  const onStep = (st: AgentStep) => {
    const last = parts[parts.length - 1];
    if (st.kind === 'text' && st.delta && last?.kind === 'text') last.text += st.text;
    else parts.push({ kind: st.kind, text: st.text });
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };

  let res: AgentResult = { ok: false, text: '', usage: emptyUsage(), error: 'Агент не запустился' };
  let changed: string[] | undefined;
  try {
    const s = h.opts.getSettings();
    const agent = chat.agent;
    const tools = await h.tools([agent]);
    const cwd = chat.projectPath ?? path.join(chatFilesDir(h, id), 'work');
    fs.mkdirSync(cwd, { recursive: true });
    // Что изменилось за ход — только для чата с правками в git-репозитории.
    const git = chat.projectPath && chat.edits && (await h.hasTool('git')) ? new Git((await h.tools(['git'])).git, h.opts.env) : null;
    const repo = git && chat.projectPath && (await git.isRepo(chat.projectPath)) ? chat.projectPath : null;
    const before = git && repo ? await snapshot(git, repo) : null;

    const session = chat.session?.agent === agent ? chat.session.id : undefined;
    const sys = systemPrompt(h, chat, cwd);
    const images = attachments.filter(isImageFile);
    const others = attachments.filter((f) => !isImageFile(f));
    let prompt = (session ? '' : historyBlock(prevMessages)) + (text.trim() || 'Посмотри вложения.');
    if (others.length) prompt += `\n\nПрикреплённые файлы (открой и прочитай):\n${others.map((f) => `- ${f}`).join('\n')}`;
    const model = chat.model || h.agentModel(agent, s.agents, s.models) || undefined;
    const common = {
      bin: tools[agent], cwd, env: h.opts.env, model, group: group(id),
      timeoutMs: 4 * 60 * 60_000, idleTimeoutMs: s.agentTimeoutMin * 60_000,
      onOutput: () => {}, onStep, proxy: s.proxy.baseUrl ? s.proxy : undefined, userConfig: s.userConfig,
      addDirs: attachments.length ? [path.dirname(attachments[0])] : undefined,
    };
    if (agent === 'codex') {
      let thread = session;
      res = await h.codex({
        ...common, prompt, systemPrompt: session ? undefined : sys, images,
        sandbox: chat.edits ? 'workspace-write' : 'read-only', persist: true, resumeThread: session,
        onSession: (sid) => { thread = sid; },
      });
      if (thread) chat.session = { agent, id: thread };
    } else {
      // claude не принимает изображения флагом — даём пути, он откроет их инструментом Read.
      if (images.length) prompt += `\n\nИзображения (открой инструментом Read):\n${images.map((f) => `- ${f}`).join('\n')}`;
      const sessionId = session ?? crypto.randomUUID();
      res = await h.claude({
        ...common, prompt, claudeAuth: s.claudeAuth, partial: true,
        systemPrompt: session ? undefined : sys,
        resume: session, sessionId: session ? undefined : sessionId,
        tools: chat.edits ? undefined : ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      });
      // Сессия сохраняется, только если claude успел её начать.
      if (res.ok || parts.length) chat.session = { agent, id: sessionId };
    }
    if (git && repo && before) {
      const after = await snapshot(git, repo);
      changed = [...after].filter(([f, t]) => before.get(f) !== t).map(([f]) => f);
      for (const f of before.keys()) if (!after.has(f)) changed.push(f);
    }
  } catch (e) {
    res = { ok: false, text: '', usage: emptyUsage(), error: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Финальный ответ: если шагов не было (ошибка до старта или codex без событий), берём итоговый текст.
  if (!parts.some((p) => p.kind === 'text') && res.text.trim()) parts.push({ kind: 'text', text: res.text.trim() });
  answer.parts = parts;
  answer.text = parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n\n');
  answer.pending = false;
  answer.usage = res.usage;
  if (changed?.length) answer.changedFiles = [...new Set(changed)];
  if (res.stopped) answer.stopped = true;
  else if (!res.ok) answer.error = res.error ?? 'Агент не ответил';
  save(h, chat);
}

/** Черновик задачи для конвейера по переписке: формулировку пишет модель, вложения переходят в задачу. */
export async function chatToTask(h: Orchestrator, id: string): Promise<NextPartDraft> {
  const chat = must(h, id);
  const talk = chat.messages.filter((m) => !m.pending && m.text.trim()).slice(-30)
    .map((m) => `${m.role === 'user' ? 'Человек' : 'Ассистент'}: ${m.text.trim().slice(0, 6000)}`).join('\n\n');
  if (!talk) throw new Error('В чате пока нечего превращать в задачу');
  const prompt = `Ниже переписка человека с ассистентом о проекте. Сформулируй по ней задачу для разработчика: что сделать и зачем, важные детали и решения из переписки, критерии готовности. Пиши по-русски, коротко и конкретно, в Markdown, без вступления и без обращения к человеку. Верни только текст задачи.\n\n---\n\n${talk}`;
  const res = await h.service({ prompt, group: `${group(id)}:task`, timeoutMs: 3 * 60_000 });
  if (!res.ok || !res.text.trim()) throw new Error(res.error ?? 'Не получилось сформулировать задачу');
  const attachments = chat.messages.flatMap((m) => m.attachments ?? []).filter((f) => fs.existsSync(f));
  return { projectPath: chat.projectPath ?? '', task: res.text.trim(), attachments, rest: [] };
}

/** Git-репозиторий проекта чата, если он есть. */
async function chatRepo(h: Orchestrator, id: string): Promise<{ git: Git; repo: string } | null> {
  const chat = must(h, id);
  if (!chat.projectPath || !(await h.hasTool('git'))) return null;
  const git = new Git((await h.tools(['git'])).git, h.opts.env);
  return (await git.isRepo(chat.projectPath)) ? { git, repo: chat.projectPath } : null;
}

/** Незакоммиченные изменения проекта чата относительно HEAD — вкладка «Код» в чате. */
export async function chatDiff(h: Orchestrator, id: string): Promise<DiffFile[]> {
  const r = await chatRepo(h, id);
  return r ? r.git.diff(r.repo, 'HEAD') : [];
}

export async function chatChangedFiles(h: Orchestrator, id: string): Promise<string[]> {
  const r = await chatRepo(h, id);
  return r ? r.git.changedFiles(r.repo, 'HEAD') : [];
}

/** Приложение проекта чата во вкладке «Браузер»: команды «Запуск приложения» и «Адрес» из настроек проекта. */
export async function startChatPreview(h: Orchestrator, id: string): Promise<PreviewState> {
  const chat = must(h, id);
  const cur = h.getPreview(id);
  if (cur.status === 'starting' || cur.status === 'ready') return cur;
  if (!chat.projectPath) throw new Error('У чата нет проекта — откройте адрес вручную.');
  const cfg = h.getProjectConfig(chat.projectPath);
  if (!cfg?.runCommand || !cfg.appUrl) throw new Error('Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты») или откройте адрес вручную.');
  return h.launchPreview(id, { repo: chat.projectPath, cwd: chat.projectPath, runCommand: cfg.runCommand, appUrl: cfg.appUrl });
}
