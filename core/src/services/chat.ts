// Чат: разговор с агентом вне конвейера — потоковый ответ, очередь сообщений, правки проекта, «Сделать задачей».
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emptyUsage, type AgentResult, type AgentStep } from '../agents/common.js';
import { isImageFile } from '../files.js';
import { Git } from '../git.js';
import { writeFiles } from './attachments.js';
import type { Kernel } from '../kernel.js';
import { killGroup } from '../proc.js';
import { writeAtomic } from '../store.js';
import { applyStep, partsText, settleParts, type ChatAnswer } from '../chatparts.js';
import type {
  AgentKind,
  ChatFile,
  ChatFileContent,
  ChatMessage,
  ChatPart,
  ChatSkill,
  ChatSummary,
  DiffFile,
  NextPartDraft,
  PreviewState,
} from '../types.js';
import { effortFor, enabledAgent } from '../types.js';
import { AGY_PROXY_DEFAULT_MODEL, type AgyPermissionAnswer } from '../agents/agy.js';
import { PROXY_DEFAULT_MODEL } from '../agents/opencode.js';
import { agentModel, service, serviceAgent } from './agents.js';
import { findMentions, listSkills, mentionsBlock, walkFiles } from './mentions.js';
import { launchPreview, stopPreview } from './preview.js';
import { chatBrowser, closeChatBrowser } from './chatbrowser.js';
import { getProjectConfig, knowledgeOf } from './projects.js';

/**
 * Чат — обычный разговор с claude или codex вне конвейера: вопросы по проекту и небольшие правки,
 * которым не нужны план, ревью и приёмка. Каждый ход — запуск CLI, контекст держит его сессия.
 */

/** Сколько последних сообщений пересказать, если сессии CLI нет (сменили агента). */
const HISTORY = 12;
/** Как часто отправлять в окно ответ, который ещё пишется. */
const FLUSH_MS = 120;

const chatsDir = (k: Kernel) => path.join(k.opts.dataDir, 'chats');
const chatFile = (k: Kernel, id: string) => path.join(chatsDir(k), `${id}.json`);
/** Вложения и рабочая папка чата без проекта. */
const chatFilesDir = (k: Kernel, id: string) => path.join(chatsDir(k), id);
const group = (id: string) => `chat:${id}`;

/** Запросы разрешений agy, которые ждут ответа человека: чат → id запроса → ответ (expired — ход кончился без ответа). */
const asks = new Map<string, Map<string, (a: AgyPermissionAnswer | 'expired') => void>>();

/** Ответ человека на запрос разрешения agy в «Правках». */
export function answerChatPermission(id: string, requestId: string, answer: AgyPermissionAnswer): void {
  const r = asks.get(id)?.get(requestId);
  if (!r) throw new Error('Запрос уже не ждёт ответа');
  r(answer);
}

/** Чат, по которому идёт ход: одна копия в памяти, чтобы сообщения в очередь и правки настроек не затирались сохранениями хода. */
const live = new WeakMap<Kernel, Map<string, ChatFile>>();
const liveOf = (k: Kernel) => {
  let m = live.get(k);
  if (!m) live.set(k, (m = new Map()));
  return m;
};

/** Чаты, которым сейчас придумывается название. */
const titlingNow = new Set<string>();

function read(k: Kernel, id: string): ChatFile | null {
  const cur = liveOf(k).get(id);
  if (cur) return cur;
  try {
    const chat = JSON.parse(fs.readFileSync(chatFile(k, id), 'utf8')) as ChatFile;
    // Ответ, который писался при закрытии приложения, уже не допишется.
    if (!k.chatBusy.has(id)) for (const m of chat.messages) if (m.pending) Object.assign(m, { pending: false, stopped: true });
    // Название придумывалось, когда приложение закрыли, — заглушка не должна висеть вечно.
    if (chat.titling && !titlingNow.has(id)) delete chat.titling;
    return chat;
  } catch {
    return null;
  }
}

function must(k: Kernel, id: string): ChatFile {
  const c = read(k, id);
  if (!c) throw new Error('Чат не найден');
  return c;
}

/** Удалённые чаты: ход, который ещё доигрывает, не должен воскресить файл. */
const deleted = new Set<string>();

function save(k: Kernel, chat: ChatFile) {
  if (deleted.has(chat.id)) return;
  chat.updatedAt = new Date().toISOString();
  writeAtomic(chatFile(k, chat.id), JSON.stringify(chat, null, 2));
  k.emit({ type: 'chat.updated', chat: structuredClone(chat), busy: k.chatBusy.has(chat.id) });
}

/** Строка чата в истории: last — итог последнего ответа агента. */
export function chatSummary(c: ChatFile, busy: boolean): ChatSummary {
  const answer = [...c.messages].reverse().find((m) => m.role === 'assistant' && !m.pending);
  const last = answer ? (answer.error || answer.stopped ? 'error' : 'ok') : null;
  return {
    id: c.id,
    title: c.title,
    projectPath: c.projectPath,
    agent: c.agent,
    updatedAt: c.updatedAt,
    busy,
    last,
    ...(c.titling ? { titling: true } : {}),
  };
}

export function listChats(k: Kernel): ChatSummary[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(chatsDir(k)).filter((f) => f.endsWith('.json'));
  } catch {
    /* чатов ещё нет */
  }
  return files
    .map((f) => read(k, f.slice(0, -5)))
    .filter((c): c is ChatFile => Boolean(c))
    .map((c) => chatSummary(c, k.chatBusy.has(c.id)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getChat(k: Kernel, id: string): { chat: ChatFile; busy: boolean } | null {
  const chat = read(k, id);
  return chat ? { chat, busy: k.chatBusy.has(id) } : null;
}

export async function createChat(
  k: Kernel,
  o: { projectPath?: string; agent?: AgentKind; model?: string; effort?: string; edits?: boolean; fullAccess?: boolean; dirs?: string[] },
): Promise<ChatFile> {
  const now = new Date().toISOString();
  const agent = o.agent ?? (await serviceAgent(k));
  const projectPath = o.projectPath?.trim() || undefined;
  if (projectPath && !fs.existsSync(projectPath)) throw new Error('Папка проекта не найдена');
  const chat: ChatFile = {
    id: `chat-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    title: 'Новый чат',
    projectPath,
    agent,
    model: o.model ?? '',
    effort: effortFor(agent, o.effort),
    edits: o.edits ?? true,
    ...((o.edits ?? true) && o.fullAccess ? { fullAccess: true } : {}),
    ...(o.dirs?.length ? { dirs: contextDirs(o.dirs, projectPath) } : {}),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  fs.mkdirSync(chatsDir(k), { recursive: true });
  save(k, chat);
  return chat;
}

/** Название, агент, модель и правки. Смена агента или правок начинает новую сессию — история уйдёт пересказом. */
export function updateChat(
  k: Kernel,
  id: string,
  patch: Partial<Pick<ChatFile, 'title' | 'agent' | 'model' | 'effort' | 'edits' | 'fullAccess' | 'dirs'>>,
): ChatFile {
  const chat = must(k, id);
  if (patch.dirs !== undefined) {
    const dirs = contextDirs(patch.dirs, chat.projectPath);
    chat.dirs = dirs.length ? dirs : undefined;
  }
  if (patch.title !== undefined) {
    chat.title = patch.title.trim().slice(0, 120) || chat.title;
    // Переименовал человек — модель название больше не трогает.
    chat.autoTitle = undefined;
    delete chat.titling;
    titlingNow.delete(id);
  }
  if (patch.agent && patch.agent !== chat.agent) chat.agent = patch.agent;
  if (patch.model !== undefined) chat.model = patch.model.trim();
  // '' — снова «как в CLI»; уровень, которого новый агент не знает, сбрасывается.
  if (patch.effort !== undefined) chat.effort = patch.effort || undefined;
  chat.effort = effortFor(chat.agent, chat.effort);
  // Правила чата уходят в начале сессии: «только чтение» в ней осталось бы и после включения правок — и наоборот.
  const access = (c: Pick<ChatFile, 'edits' | 'fullAccess'>) => (c.edits ? (c.fullAccess ? 'full' : 'edits') : 'read');
  const was = access(chat);
  if (patch.edits !== undefined) chat.edits = patch.edits;
  if (patch.fullAccess !== undefined) chat.fullAccess = patch.fullAccess || undefined;
  // Полный доступ — только поверх правок.
  if (!chat.edits) chat.fullAccess = undefined;
  if (access(chat) !== was) chat.session = undefined;
  save(k, chat);
  return chat;
}

/**
 * Папки для контекста: только существующие абсолютные каталоги, без повторов и без папки проекта —
 * она у агента и так рабочая. Ошибка — если человек добавил то, что папкой не является.
 */
export function contextDirs(dirs: string[], projectPath?: string): string[] {
  const out: string[] = [];
  for (const raw of dirs) {
    const d = raw.trim();
    if (!d) continue;
    if (!path.isAbsolute(d)) throw new Error(`Нужен полный путь к папке: ${d}`);
    let st: fs.Stats;
    try {
      st = fs.statSync(d);
    } catch {
      throw new Error(`Папка не найдена: ${d}`);
    }
    if (!st.isDirectory()) throw new Error(`Это не папка: ${d}`);
    const norm = path.resolve(d);
    if (projectPath && path.resolve(projectPath) === norm) continue;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/** Папки чата в промпте хода: пути, чтобы агент знал, где искать. Удалённые с диска — пропускаем. */
function dirsBlock(dirs: string[]): string {
  return dirs.length
    ? `\n\nПапки, добавленные в контекст чата (читай их, когда нужно для ответа; меняй только по прямой просьбе):\n${dirs.map((d) => `- ${d}`).join('\n')}`
    : '';
}

export async function deleteChat(k: Kernel, id: string): Promise<void> {
  deleted.add(id);
  liveOf(k).delete(id);
  await killGroup(group(id));
  await stopPreview(k, id);
  await closeChatBrowser(k, id, chatFilesDir(k, id)).catch(() => undefined);
  k.chatBusy.delete(id);
  fs.rmSync(chatFile(k, id), { force: true });
  fs.rmSync(chatFilesDir(k, id), { recursive: true, force: true });
  k.emit({ type: 'chat.deleted', chatId: id });
}

export async function stopChat(k: Kernel, id: string): Promise<void> {
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
    } catch {
      /* удалён */
    }
    out.set(p, t);
  }
  return out;
}

function systemPrompt(k: Kernel, chat: ChatFile, cwd: string): string {
  const where = chat.projectPath
    ? `Ты работаешь в проекте ${chat.projectPath} — это рабочая папка.`
    : `Проекта нет: рабочая папка ${cwd} — временная папка этого чата.`;
  const rules = !chat.edits
    ? 'Режим только чтения: файлы не меняй, команды, которые что-то меняют, не запускай. Если нужна правка — предложи её текстом или посоветуй завести задачу в PurpleFlow.'
    : chat.fullAccess
      ? 'Режим полного доступа: можно менять файлы, работать с git (коммиты, ветки), управлять процессами и запускать любые команды — но только когда человек об этом просит. Делай ровно то, что попросили, не трогай лишнего; коммиты, пуш и остановку процессов — только по прямой просьбе. В конце коротко перечисли, что сделал.'
      : 'Тебе можно менять файлы проекта, но только когда человек об этом просит. Это небольшие задачи без плана и ревью: делай ровно то, что попросили, не трогай лишнего и не делай коммитов. Git на запись, остановка процессов и файлы вне проекта в этом режиме закрыты песочницей — если без них не обойтись, скажи, что нужен режим «Полный доступ». В конце коротко перечисли, что изменил.';
  let s = `Ты — ассистент в чате PurpleFlow. ${where} ${rules} Отвечай по-русски, по делу, в Markdown.`;
  if (chat.projectPath) {
    const kn = knowledgeOf(k, chat.projectPath);
    const lessons = kn.lessons?.map((l) => `- ${l.text}`).join('\n');
    if (kn.profile) s += `\n\n## Профиль проекта\n\n${kn.profile.trim()}`;
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

// Метка времени с номером: два файла с одним именем в одном сообщении не затирают друг друга.
const saveAttachments = (k: Kernel, id: string, files: { name: string; data: Uint8Array }[]): string[] =>
  writeFiles(path.join(chatFilesDir(k, id), 'files'), files, (i) => `${Date.now().toString(36)}-${i}`);

/**
 * Сообщение человека. Если агент свободен — сразу ход; если отвечает — сообщение встаёт в очередь
 * и уходит следующим ходом (все накопленные — одним). «Прервать и отправить» — это stopChat: ход обрывается, очередь уходит.
 */
export async function sendChat(k: Kernel, id: string, text: string, files: { name: string; data: Uint8Array }[] = []): Promise<void> {
  if (!text.trim() && !files.length) throw new Error('Пустое сообщение');
  const chat = must(k, id);
  const attachments = saveAttachments(k, id, files);
  chat.messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    at: new Date().toISOString(),
    text: text.trim(),
    attachments: attachments.length ? attachments : undefined,
    queued: true,
  });
  if (chat.title === 'Новый чат' && text.trim()) {
    chat.title = text.trim().replace(/\s+/g, ' ').slice(0, 60);
    chat.autoTitle = true;
    // Название от модели придёт после ответа — заглушка на его месте сразу, без мелькания текста.
    if (k.opts.chatTitles !== false) {
      chat.titling = true;
      titlingNow.add(id);
    }
  }
  save(k, chat);
  if (k.chatBusy.has(id)) return;
  await drive(k, chat);
}

/**
 * Разрешить codex инструмент MCP, в котором он отказал (codex exec не умеет спросить человека),
 * и попросить повторить вызов. always — на весь чат, иначе только на следующий ход. Песочница файлов не меняется.
 */
export async function allowChatMcp(k: Kernel, id: string, t: { server: string; tool: string; always?: boolean }): Promise<void> {
  const chat = must(k, id);
  const tool = { server: t.server, tool: t.tool };
  const has = (l?: { server: string; tool: string }[]) => l?.some((x) => x.server === tool.server && x.tool === tool.tool);
  if (t.always) {
    if (!has(chat.mcpAllow)) chat.mcpAllow = [...(chat.mcpAllow ?? []), tool];
  } else if (!has(chat.mcpOnce)) chat.mcpOnce = [...(chat.mcpOnce ?? []), tool];
  save(k, chat);
  await sendChat(k, id, `Разрешаю вызов ${tool.server} · ${tool.tool} — повтори его.`);
}

/** Агент сам говорит, что нужен полный доступ: правила режима правок просят его назвать режим «Полный доступ». */
const ASKS_FULL_ACCESS = /полн\S* доступ/i;

/**
 * Ход упёрся в ограничения правок. По выводу команды это видно не всегда: codex (0.172) отказ песочницы
 * не присылает событием command_execution — только текстом ответа. Поэтому ещё и по просьбе агента в тексте.
 */
export function needsFullAccess(parts: ChatPart[]): boolean {
  return parts.some((p) => (p.kind === 'tool' && p.sandboxDenied) || (p.kind === 'text' && ASKS_FULL_ACCESS.test(p.text)));
}

/**
 * Песочница правок не пустила команду: включить чату полный доступ и попросить повторить.
 * Смена режима начинает новую сессию — переписка уйдёт агенту пересказом.
 */
export async function grantChatFullAccess(k: Kernel, id: string): Promise<void> {
  if (k.chatBusy.has(id)) throw new Error('Агент отвечает — дайте доступ после ответа');
  updateChat(k, id, { edits: true, fullAccess: true });
  await sendChat(k, id, 'Включил полный доступ — повтори то, что не пустила песочница.');
}

/**
 * Сжать контекст сессии claude (/compact): переписка остаётся, агент помнит её в пересказе, окно освобождается.
 * Ответом — уведомление о сжатии; сообщения, присланные во время сжатия, уходят следующим ходом.
 */
export async function compactChat(k: Kernel, id: string): Promise<void> {
  const chat = must(k, id);
  if (chat.agent !== 'claude' || chat.session?.agent !== 'claude')
    throw new Error(
      chat.agent === 'claude' ? 'Сжимать пока нечего — сессия начнётся с первым сообщением' : `${chat.agent} сжимает контекст сам`,
    );
  if (k.chatBusy.has(id)) throw new Error('Агент отвечает — сожмите контекст после ответа');
  await drive(k, chat, true);
}

/** Ходы чата, пока есть очередь; compact — сначала сжать контекст. */
async function drive(k: Kernel, chat: ChatFile, compact = false): Promise<void> {
  const id = chat.id;
  k.chatBusy.add(id);
  liveOf(k).set(id, chat);
  try {
    if (compact) await turn(k, chat, [], true);
    // Пока есть очередь — ход за ходом: сообщения, присланные во время ответа, уходят следующим ходом.
    for (;;) {
      const batch = chat.messages.filter((m) => m.queued);
      if (!batch.length || !liveOf(k).has(id)) break;
      await turn(k, chat, batch);
    }
  } finally {
    k.chatBusy.delete(id);
    if (liveOf(k).get(id) === chat) {
      liveOf(k).delete(id);
      save(k, chat);
    }
  }
}

/** Убрать сообщение из очереди, пока оно не ушло агенту. */
export function unqueueChat(k: Kernel, id: string, messageId: string): ChatFile {
  const chat = must(k, id);
  const m = chat.messages.find((x) => x.id === messageId);
  if (!m?.queued) throw new Error('Сообщение уже ушло агенту');
  chat.messages = chat.messages.filter((x) => x.id !== messageId);
  save(k, chat);
  return chat;
}

/**
 * Один ход: сообщения человека из очереди и ответ агента. Ответ приходит событиями chat.updated по мере генерации.
 * compact — служебный ход без сообщений человека: /compact в текущей сессии claude.
 */
async function turn(k: Kernel, chat: ChatFile, batch: ChatMessage[], compact = false): Promise<void> {
  const id = chat.id;
  const first = compact ? chat.messages.length : chat.messages.indexOf(batch[0]);
  const prevMessages = chat.messages.slice(0, first).filter((m) => !m.queued);
  for (const m of batch) m.queued = undefined;
  // Сообщения из очереди встают перед ответом, даже если пришли, пока писался прошлый.
  chat.messages = [...chat.messages.filter((m) => !batch.includes(m)), ...batch];
  const attachments = batch.flatMap((m) => m.attachments ?? []);
  const lastAnswer = [...prevMessages].reverse().find((m) => m.role === 'assistant');
  const said = batch
    .map((m) => m.text.trim())
    .filter(Boolean)
    .join('\n\n');
  const text = (lastAnswer?.stopped ? 'Я прервал твой предыдущий ответ.\n\n' : '') + said;
  const at = () => new Date().toISOString();
  const answer: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', at: at(), text: '', parts: [], pending: true };
  chat.messages.push(answer);
  save(k, chat);

  // Шаги ответа копятся здесь и уходят в окно не чаще FLUSH_MS.
  const acc: ChatAnswer = { parts: [] };
  const parts = acc.parts;
  /** Карточка под ответом, если картинку попросили, а рисовать нечем (нет входа или картинки выключены). */
  let offer: 'signup' | 'enable' | null = null;
  let timer: NodeJS.Timeout | null = null;
  const sync = () => {
    answer.parts = structuredClone(parts);
    answer.text = partsText(parts);
    if (acc.model) answer.model = acc.model;
    if (acc.turns != null) answer.turns = acc.turns;
    if (acc.durationMs != null) answer.durationMs = acc.durationMs;
    if (acc.info) answer.info = structuredClone(acc.info);
  };
  const flush = () => {
    timer = null;
    sync();
    save(k, chat);
  };
  const onStep = (st: AgentStep) => {
    applyStep(acc, st);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  /** Сразу в окно: карточка запроса не должна ждать следующего куска ответа. */
  const flushNow = () => {
    if (timer) clearTimeout(timer);
    flush();
  };

  let res: AgentResult;
  let changed: string[] | undefined;
  try {
    const s = k.opts.getSettings();
    // Агент чата мог быть выключен в настройках — отвечает включённый, со своей моделью по умолчанию.
    const agent = enabledAgent(s, chat.agent);
    const tools = await k.tools([agent]);
    const cwd = chat.projectPath ?? path.join(chatFilesDir(k, id), 'work');
    fs.mkdirSync(cwd, { recursive: true });
    // Что изменилось за ход — только для чата с правками в git-репозитории.
    const git =
      !compact && chat.projectPath && chat.edits && (await k.hasTool('git')) ? new Git((await k.tools(['git'])).git, k.opts.env) : null;
    const repo = git && chat.projectPath && (await git.isRepo(chat.projectPath)) ? chat.projectPath : null;
    const before = git && repo ? await snapshot(git, repo) : null;

    const session = chat.session?.agent === agent ? chat.session.id : undefined;
    // Браузер для агента (pw): открывает ядро, экран — во вкладке «Браузер» чата.
    const browser = compact
      ? null
      : await chatBrowser(k, { id, dir: chatFilesDir(k, id), text: said, readOnly: !chat.edits }).catch(() => null);
    // Картинки через MCP PurpleSchool — включены в настройках аккаунта; умеют подключать его claude и codex.
    const media = !compact && s.media && (agent === 'claude' || agent === 'codex') ? s.media : undefined;
    // Картинок нет, а человек просит нарисовать — под ответом карточка: войти в PurpleSchool или включить картинки.
    if (!compact && !media && s.mediaOffer && wantsImage(said)) offer = s.mediaOffer;
    const sys = systemPrompt(k, chat, cwd) + (browser ? `\n${browser.block}` : '') + (media ? `\n\n${k.prompts.raw('chat-media.md')}` : '');
    const images = attachments.filter(isImageFile);
    const others = attachments.filter((f) => !isImageFile(f));
    let prompt = (session ? '' : historyBlock(prevMessages)) + (text.trim() || 'Посмотри вложения.');
    if (others.length) prompt += `\n\nПрикреплённые файлы (открой и прочитай):\n${others.map((f) => `- ${f}`).join('\n')}`;
    // @файлы и /скиллы из сообщения — отдельным блоком: CLI в неинтерактивном режиме их сами не разворачивают.
    const dirs = (chat.dirs ?? []).filter((d) => fs.existsSync(d));
    if (!compact) prompt += dirsBlock(dirs);
    prompt += mentionsBlock(findMentions(said, cwd, listSkills({ projectPath: chat.projectPath, userConfig: Boolean(s.userConfig) })));
    if (browser) prompt += `\n\n${browser.note}`;
    // Сжатие — встроенная команда CLI: только она, без истории и вложений.
    if (compact) prompt = '/compact';
    const model = (agent === chat.agent ? chat.model : '') || chatDefaultModel(k, agent) || undefined;
    const effort = agent === chat.agent ? effortFor(agent, chat.effort) : undefined;
    if (effort) answer.effort = effort;
    const common = {
      bin: tools[agent],
      cwd,
      env: browser?.env ?? k.opts.env,
      model,
      effort,
      group: group(id),
      timeoutMs: 4 * 60 * 60_000,
      idleTimeoutMs: s.agentTimeoutMin * 60_000,
      onOutput: () => {},
      onStep,
      proxy: s.proxy.baseUrl ? s.proxy : undefined,
      media,
      userConfig: s.userConfig,
      addDirs: [...dirs, ...(attachments.length ? [path.dirname(attachments[0])] : []), ...(browser ? [browser.dir] : [])].filter(
        (d, i, all) => all.indexOf(d) === i,
      ),
    };
    if (agent === 'opencode') {
      let sid = session;
      res = await k.opencode({
        ...common,
        prompt,
        systemPrompt: session ? undefined : sys,
        images,
        readOnly: !chat.edits,
        limited: chat.edits && !chat.fullAccess,
        resumeSession: session,
        onSession: (id) => {
          sid = id;
        },
      });
      if (sid) chat.session = { agent, id: sid };
    } else if (agent === 'agy') {
      let conv = session;
      const waiting = new Map<string, (a: AgyPermissionAnswer | 'expired') => void>();
      asks.set(id, waiting);
      try {
        res = await k.agy({
          ...common,
          prompt,
          systemPrompt: session ? undefined : sys,
          images,
          // В «Правках» действие вне режима решает человек: карточка в ответе, agy ждёт.
          askPermission:
            chat.edits && !chat.fullAccess
              ? (q) =>
                  new Promise<AgyPermissionAnswer>((resolve) => {
                    waiting.set(q.id, (a) => {
                      waiting.delete(q.id);
                      onStep({ kind: 'permission', ...q, state: a === 'deny' ? 'denied' : a });
                      flushNow();
                      resolve(a === 'expired' ? 'deny' : a);
                    });
                    onStep({ kind: 'permission', ...q, state: 'pending' });
                    flushNow();
                  })
              : undefined,
          allowed: chat.agyAllow,
          onAllow: (key) => {
            chat.agyAllow = [...new Set([...(chat.agyAllow ?? []), key])];
          },
          // Режимы чата: решения по каждому запросу разрешения agy (ACP), как песочницы codex и claude.
          readOnly: !chat.edits,
          limited: chat.edits && !chat.fullAccess,
          resumeConversation: session,
          onSession: (sid) => {
            conv = sid;
          },
        });
      } finally {
        // Ход кончился (ответ, стоп, сбой) — неотвеченные карточки гаснут, agy уже не ждёт.
        for (const r of [...waiting.values()]) r('expired');
        asks.delete(id);
      }
      if (conv) chat.session = { agent, id: conv };
    } else if (agent === 'codex') {
      let thread = session;
      res = await k.codex({
        ...common,
        prompt,
        systemPrompt: session ? undefined : sys,
        images,
        sandbox: !chat.edits ? 'read-only' : chat.fullAccess ? 'danger-full-access' : 'workspace-write',
        persist: true,
        resumeThread: session,
        mcpApprove: [...(chat.mcpAllow ?? []), ...(chat.mcpOnce ?? [])],
        onSession: (sid) => {
          thread = sid;
        },
      });
      if (thread) chat.session = { agent, id: thread };
      chat.mcpOnce = undefined;
    } else {
      // claude не принимает изображения флагом — даём пути, он откроет их инструментом Read.
      if (images.length) prompt += `\n\nИзображения (открой инструментом Read):\n${images.map((f) => `- ${f}`).join('\n')}`;
      const sessionId = session ?? crypto.randomUUID();
      res = await k.claude({
        ...common,
        prompt,
        claudeAuth: s.claudeAuth,
        partial: true,
        systemPrompt: session ? undefined : sys,
        resume: session,
        sessionId: session ? undefined : sessionId,
        tools: chat.edits ? undefined : ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
        // Правки без полного доступа: bash в песочнице Claude Code — запись только в проект, .git закрыт.
        sandbox: chat.edits && !chat.fullAccess ? cwd : undefined,
        sandboxSockets: browser?.sockets,
      });
      // Сессия сохраняется, только если claude успел её начать.
      if (res.ok || parts.length) chat.session = { agent, id: sessionId };
    }
    // Продолжение упало сразу: сессия могла истечь. Следующее сообщение начнёт новую, история уйдёт пересказом — иначе чат не оживёт.
    if (session && !res.ok && !res.stopped && !parts.length) chat.session = undefined;
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

  // Сжатие прошло, но CLI не сообщил о нём (старая версия) — всё равно говорим, что сделано.
  if (compact && res.ok && !parts.some((p) => p.kind === 'notice' && p.key === 'compact'))
    parts.push({
      kind: 'notice',
      level: 'info',
      key: 'compact',
      text: 'Контекст переписки сжат: ранние сообщения агент помнит в пересказе',
    });
  // Финальный ответ: если текста не было (ошибка до старта или codex без событий), берём итоговый текст.
  if (!parts.some((p) => p.kind === 'text') && res.text.trim()) parts.push({ kind: 'text', text: res.text.trim() });
  if (offer && !res.stopped) parts.push({ kind: 'offer', offer });
  settleParts(parts);
  sync();
  answer.pending = false;
  answer.usage = res.usage;
  if (changed?.length) answer.changedFiles = [...new Set(changed)];
  if (chat.edits && !chat.fullAccess && !res.stopped && needsFullAccess(parts)) answer.needsFullAccess = true;
  if (res.stopped) answer.stopped = true;
  else if (!res.ok) answer.error = res.error ?? 'Агент не ответил';
  save(k, chat);
  // Первый удачный ответ — название от модели, в фоне: ход и очередь его не ждут.
  if (chat.autoTitle && res.ok && answer.text.trim() && k.opts.chatTitles !== false) {
    chat.autoTitle = undefined;
    void nameChat(k, chat.id, chat.title).catch(() => undefined);
  } else if (chat.autoTitle && chat.titling) {
    // Ответ не удался — заглушка уходит, остаётся название из сообщения; попробуем после следующего ответа.
    delete chat.titling;
    titlingNow.delete(chat.id);
    save(k, chat);
  }
}

/** Промпт названия чата: начало переписки. По нему же фейковый claude в e2e узнаёт этот запрос. */
export const TITLE_PROMPT = 'Придумай короткое название для чата по началу переписки';

/** Ответ модели → название: первая строка, без кавычек, разметки и точки в конце. */
export function cleanTitle(text: string): string {
  const line =
    text
      .trim()
      .split('\n')
      .find((l) => l.trim()) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/^(название|title)\s*:\s*/i, '')
    .replace(/[.。]+$/, '')
    .replace(/^[«"'`*_]+|[»"'`*_]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim()
    .slice(0, 60);
}

/**
 * Название чата от модели: 2–6 слов по первому сообщению и ответу. Человек успел переименовать
 * (название уже не то, с которым начинали) — не трогаем.
 */
async function nameChat(k: Kernel, id: string, was: string): Promise<void> {
  const first = must(k, id);
  const user =
    first.messages
      .find((m) => m.role === 'user')
      ?.text.trim()
      .slice(0, 2000) ?? '';
  const reply =
    first.messages
      .find((m) => m.role === 'assistant' && !m.pending)
      ?.text.trim()
      .slice(0, 2000) ?? '';
  if (!user) {
    titlingNow.delete(id);
    delete first.titling;
    save(k, first);
    return;
  }
  // Окно показывает заглушку, пока модель думает. must() отдаёт живой экземпляр, если идёт ход.
  titlingNow.add(id);
  first.titling = true;
  save(k, first);
  let title = '';
  try {
    const prompt = `${TITLE_PROMPT}: 2–6 слов, на языке переписки, без кавычек и точки в конце. Верни только название.\n\nЧеловек: ${user}\n\nАссистент: ${reply}`;
    const res = await service(k, { prompt, group: `${group(id)}:title`, timeoutMs: 60_000 });
    title = res.ok ? cleanTitle(res.text) : '';
  } finally {
    titlingNow.delete(id);
    // Пока ждали, чат могли удалить или изменить: берём живой экземпляр (идёт следующий ход) или свежий с диска.
    const chat = read(k, id);
    if (chat) {
      delete chat.titling;
      // Человек успел переименовать — его название остаётся.
      if (title && chat.title === was) chat.title = title;
      save(k, chat);
    }
  }
}

/** Черновик задачи для конвейера по переписке: формулировку пишет модель, вложения переходят в задачу. */
export async function chatToTask(k: Kernel, id: string): Promise<NextPartDraft> {
  const chat = must(k, id);
  const talk = chat.messages
    .filter((m) => !m.pending && m.text.trim())
    .slice(-30)
    .map((m) => `${m.role === 'user' ? 'Человек' : 'Ассистент'}: ${m.text.trim().slice(0, 6000)}`)
    .join('\n\n');
  if (!talk) throw new Error('В чате пока нечего превращать в задачу');
  const prompt = `Ниже переписка человека с ассистентом о проекте. Сформулируй по ней задачу для разработчика: что сделать и зачем, важные детали и решения из переписки, критерии готовности. Пиши по-русски, коротко и конкретно, в Markdown, без вступления и без обращения к человеку. Верни только текст задачи.\n\n---\n\n${talk}`;
  const res = await service(k, { prompt, group: `${group(id)}:task`, timeoutMs: 3 * 60_000 });
  if (!res.ok || !res.text.trim()) throw new Error(res.error ?? 'Не получилось сформулировать задачу');
  const attachments = chat.messages.flatMap((m) => m.attachments ?? []).filter((f) => fs.existsSync(f));
  return { projectPath: chat.projectPath ?? '', task: res.text.trim(), attachments, rest: [] };
}

/** Git-репозиторий проекта чата, если он есть. */
async function chatRepo(k: Kernel, id: string): Promise<{ git: Git; repo: string } | null> {
  const chat = must(k, id);
  if (!chat.projectPath || !(await k.hasTool('git'))) return null;
  const git = new Git((await k.tools(['git'])).git, k.opts.env);
  return (await git.isRepo(chat.projectPath)) ? { git, repo: chat.projectPath } : null;
}

/** Незакоммиченные изменения проекта чата относительно HEAD — вкладка «Код» в чате. */
export async function chatDiff(k: Kernel, id: string): Promise<DiffFile[]> {
  const r = await chatRepo(k, id);
  return r ? r.git.diff(r.repo, 'HEAD') : [];
}

export async function chatChangedFiles(k: Kernel, id: string): Promise<string[]> {
  const r = await chatRepo(k, id);
  return r ? r.git.changedFiles(r.repo, 'HEAD') : [];
}

/** Приложение проекта чата во вкладке «Браузер»: команды «Запуск приложения» и «Адрес» из настроек проекта. */
export async function startChatPreview(k: Kernel, id: string): Promise<PreviewState> {
  const chat = must(k, id);
  return launchPreview(k, id, () => {
    if (!chat.projectPath) throw new Error('У чата нет проекта — откройте адрес вручную.');
    const cfg = getProjectConfig(k, chat.projectPath);
    if (!cfg?.runCommand || !cfg.appUrl)
      throw new Error('Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты») или откройте адрес вручную.');
    return { repo: chat.projectPath, cwd: chat.projectPath, runCommand: cfg.runCommand, appUrl: cfg.appUrl };
  });
}

/** Рабочая папка чата без проекта: агент работает в ней, вкладка «Файлы» показывает её. */
export function chatWorkDir(k: Kernel, id: string): string {
  must(k, id);
  const dir = path.join(chatFilesDir(k, id), 'work');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Файлы проекта для «@»: из git (без игнорируемых), без git — обходом папки. */
export async function listChatFiles(k: Kernel, projectPath: string): Promise<string[]> {
  if (!projectPath || !fs.existsSync(projectPath)) return [];
  if (await k.hasTool('git')) {
    const git = new Git((await k.tools(['git'])).git, k.opts.env);
    if (await git.isRepo(projectPath)) {
      const files = await git.listFiles(projectPath).catch(() => null);
      // Удалённые, но ещё не закоммиченные файлы git всё ещё перечисляет.
      if (files) return files.filter((f) => fs.existsSync(path.join(projectPath, f))).slice(0, 20_000);
    }
  }
  return walkFiles(projectPath);
}

const MAX_VIEW = 512 * 1024;
const MEDIA: Record<string, { mime: string; max: number }> = {
  png: { mime: 'image/png', max: 25 },
  jpg: { mime: 'image/jpeg', max: 25 },
  jpeg: { mime: 'image/jpeg', max: 25 },
  gif: { mime: 'image/gif', max: 25 },
  webp: { mime: 'image/webp', max: 25 },
  avif: { mime: 'image/avif', max: 25 },
  bmp: { mime: 'image/bmp', max: 25 },
  ico: { mime: 'image/x-icon', max: 25 },
  svg: { mime: 'image/svg+xml', max: 25 },
  mp4: { mime: 'video/mp4', max: 100 },
  m4v: { mime: 'video/mp4', max: 100 },
  webm: { mime: 'video/webm', max: 100 },
  mov: { mime: 'video/quicktime', max: 100 },
  ogv: { mime: 'video/ogg', max: 100 },
};

/**
 * Файл проекта для просмотра во вкладке «Файлы» чата: только внутри папки проекта (и после разворота ссылок).
 * Текст — до 512 КБ; картинки — до 25 МБ, видео — до 100 МБ; прочий двоичный — без содержимого.
 */
export function readChatFile(projectPath: string, rel: string): ChatFileContent {
  const root = fs.realpathSync(projectPath);
  const abs = fs.realpathSync(path.resolve(root, rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Файл вне папки проекта');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('Это не файл');
  const media = MEDIA[path.extname(abs).slice(1).toLowerCase()];
  if (media) {
    const tooBig = st.size > media.max * 1024 * 1024;
    return {
      text: '',
      truncated: false,
      binary: true,
      size: st.size,
      media: { mime: media.mime, ...(tooBig ? { tooBig } : { data: new Uint8Array(fs.readFileSync(abs)) }) },
    };
  }
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_VIEW));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return { text: '', truncated: false, binary: true, size: st.size };
    return { text: buf.toString('utf8'), truncated: st.size > MAX_VIEW, binary: false, size: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Модель чата по умолчанию для агента: та, что в настройках у роли конвейера с этим агентом. Пусто — решает сам CLI. */
export function chatDefaultModel(k: Kernel, agent: AgentKind): string {
  const s = k.opts.getSettings();
  const model = agentModel(k, agent, s.agents, s.models);
  // opencode с AI-прокси без своей модели идёт в модель прокси по умолчанию — её и показываем.
  if (model || !s.proxy.baseUrl) return model;
  return agent === 'opencode' ? PROXY_DEFAULT_MODEL : agent === 'agy' ? AGY_PROXY_DEFAULT_MODEL : '';
}

/**
 * Скиллы и команды для «/» в чате и экрана проекта. Проектный скилл, которого нет в git, помечаем:
 * прогон в отдельной рабочей копии его не увидит.
 */
export async function listChatSkills(k: Kernel, projectPath?: string): Promise<ChatSkill[]> {
  const skills = listSkills({ projectPath, userConfig: Boolean(k.opts.getSettings().userConfig) });
  const own = projectPath ? skills.filter((s) => s.source === 'project') : [];
  if (!own.length || !projectPath) return skills;
  const tools = await k.tools(['git']).catch(() => null);
  const git = tools && new Git(tools.git, k.opts.env);
  if (!git || !(await git.isRepo(projectPath))) return skills;
  const root = fs.realpathSync(projectPath);
  const tracked = new Set(await git.trackedIn(projectPath, ['.claude', '.codex', '.agents', '.opencode']).catch(() => [] as string[]));
  for (const s of own) {
    const rel = path.relative(root, fs.realpathSync(s.path)).split(path.sep).join('/');
    if (!tracked.has(rel)) s.untracked = true;
  }
  return skills;
}

/** Человек просит нарисовать картинку — по словам сообщения (рисовать без MCP агенту нечем, предлагаем вход или включение). */
export function wantsImage(text: string): boolean {
  return /нарису|нарисова|(сгенерир|созда|сдела)\S*\s+(мне\s+)?(картин|изображени|иконк|логотип|обложк|иллюстрац|аватар|баннер|постер)|\bdraw\b|generate\s+(an?\s+)?(image|picture|icon|logo|illustration)/i.test(
    text,
  );
}
