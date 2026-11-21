import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { enabledAgents, type AgentKind, type CoreSettings, type Efforts, type Role } from '@purpleflow/core';
import type { PublicSettings, SettingsPatch } from '../shared/ipc';
import { diagnosticsFrom } from './diagnostics';
import { ACCOUNT_ENABLED, DEFAULT_PROXY } from './provider';

interface StoredSettings {
  toolPaths: CoreSettings['toolPaths'];
  /** enabled: false — ключ сохранён, но агенты работают по своим подпискам. */
  proxy: { baseUrl: string; codexBaseUrl: string; apiKeyEnc: string; enabled: boolean };
  models: CoreSettings['models'];
  /** Уровень рассуждений по ролям; нет — как в CLI. */
  efforts: Efforts;
  /** Роли конвейера; visual — по умолчанию claude, manager и scan — claude, если установлен, иначе codex. */
  agents: Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind; scan?: AgentKind };
  /** Какими CLI пользоваться; выключенный не выполняет ни одной роли. Хотя бы один включён. */
  enabledAgents: AgentKind[];
  agentTimeoutMin: number;
  testTimeoutMin: number;
  maxParallel: number;
  onboarded: boolean;
  windowGlass: boolean;
  /** Системные уведомления, когда прогон ждёт решения, готов или упал. */
  notify: boolean;
  /** Короткий звук в тех же случаях. */
  sound: boolean;
  claudeAuth: 'login' | 'env';
  /** Подключать агентам настройки пользователя: MCP, скиллы, плагины. */
  userConfig: boolean;
  /** Вход в аккаунт PurpleSchool: токен — только зашифрованным, email, имя и фото (data URL) — для подписи в интерфейсе. */
  account: { tokenEnc: string; email: string; name: string; photo: string };
  /** Экран входа при первом запуске уже показан: вошли или нажали «Пропустить». */
  authPrompted: boolean;
  /**
   * Отправлять разработчикам очищенные отчёты об ошибках и статистику шагов (при входе через PurpleSchool — вместе с аккаунтом).
   * Один выключатель: без статистики не понять, на каком шаге и как часто случается ошибка.
   */
  diagnostics: boolean;
  /** Случайный идентификатор установки для статистики, с аккаунтом не связан. */
  usageInstallId: string;
  /** Версия, чьё «Что нового» пользователь уже видел: выросла — после обновления показываем новое сами. */
  seenVersion: string;
}

const DEFAULTS: StoredSettings = {
  toolPaths: {},
  proxy: { baseUrl: '', codexBaseUrl: '', apiKeyEnc: '', enabled: true },
  models: { planner: 'opus', executor: 'sonnet', reviewer: '', visual: '', manager: '', scan: '' },
  efforts: {},
  agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
  enabledAgents: ['claude', 'codex'],
  agentTimeoutMin: 30,
  maxParallel: 2,
  testTimeoutMin: 10,
  onboarded: false,
  windowGlass: true,
  notify: true,
  sound: true,
  claudeAuth: 'login',
  userConfig: true,
  account: { tokenEnc: '', email: '', name: '', photo: '' },
  authPrompted: false,
  diagnostics: true,
  usageInstallId: '',
  seenVersion: '',
};

const AGENT_SLOTS = ['planner', 'executor', 'reviewer', 'visual', 'manager', 'scan'] as const;

const file = () => path.join(app.getPath('userData'), 'settings.json');

let cache: StoredSettings | null = null;

type SettingsOnDisk = Partial<StoredSettings> & {
  /** Раньше — два выключателя; выключенный любой из них выключает общий. */
  errorReports?: boolean;
  usageEvents?: boolean;
};

function load(): StoredSettings {
  if (cache) return cache;
  const settingsFile = file();
  let text: string;
  try {
    text = fs.readFileSync(settingsFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cache = structuredClone(DEFAULTS);
    return cache;
  }

  let raw: SettingsOnDisk;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('Настройки должны быть объектом JSON');
    raw = parsed as SettingsOnDisk;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Разрешаем сброс только после сохранения копии повреждённого файла.
    fs.copyFileSync(settingsFile, `${settingsFile}.broken-${Date.now()}`, fs.constants.COPYFILE_EXCL);
    cache = structuredClone(DEFAULTS);
    return cache;
  }

  const { errorReports, usageEvents, ...rest } = raw;
  cache = {
    ...DEFAULTS,
    ...rest,
    proxy: { ...DEFAULTS.proxy, ...raw.proxy },
    account: { ...DEFAULTS.account, ...raw.account },
    models: { ...DEFAULTS.models, ...raw.models },
    efforts: { ...raw.efforts },
    agents: { ...DEFAULTS.agents, ...raw.agents },
    toolPaths: { ...raw.toolPaths },
    enabledAgents: enabledAgents({ enabledAgents: raw.enabledAgents }),
    diagnostics: diagnosticsFrom({ ...raw, errorReports, usageEvents }),
  };
  return cache;
}

/** Чтение для интерфейса и запуска может повториться, когда файл снова станет доступен. */
function loadIfReadable(): StoredSettings | undefined {
  try {
    return load();
  } catch {
    return undefined;
  }
}

function persist(s: StoredSettings) {
  cache = s;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  // Через временный файл: падение посреди записи не оставит обрезанный JSON.
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file());
}

/** Ключ прокси и токен аккаунта хранятся только зашифрованными через safeStorage (Keychain / DPAPI / libsecret). */
function decryptKey(enc: string): string {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

function encryptKey(value: string): string {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Шифрование хранилища недоступно в этой системе — ключ не сохранён');
  return safeStorage.encryptString(value).toString('base64');
}

/** Версия, чьё «Что нового» уже показано. Первый запуск запоминает текущую: новичку показывать «новое» нечего. */
export function seenVersion(current: string): string {
  const s = loadIfReadable();
  if (!s) return current;
  if (!s.seenVersion) persist({ ...structuredClone(s), seenVersion: current });
  return s.seenVersion || current;
}

export function setSeenVersion(v: string) {
  persist({ ...structuredClone(load()), seenVersion: v });
}

/** Токен аккаунта PurpleSchool — только для main: в окно он не уходит. */
export function accountToken(): string {
  return decryptKey(loadIfReadable()?.account.tokenEnc ?? '');
}

export function setAccount(a: { token: string; email: string; name?: string } | null) {
  const s = structuredClone(load());
  s.account = a ? { tokenEnc: encryptKey(a.token), email: a.email, name: a.name ?? '', photo: '' } : { ...DEFAULTS.account };
  if (a) s.authPrompted = true;
  persist(s);
}

/** Имя и фото из профиля PurpleSchool; пока вход не выполнен — не сохраняем. */
export function setAccountProfile(p: { name?: string; photo?: string }) {
  const s = structuredClone(load());
  if (!s.account.tokenEnc) return;
  if (p.name) s.account.name = p.name;
  if (p.photo !== undefined) s.account.photo = p.photo;
  persist(s);
}

/** Текущий ключ прокси — чтобы отметить его в списке ключей аккаунта. */
export function proxyKey(): string {
  return decryptKey(loadIfReadable()?.proxy.apiKeyEnc ?? '');
}

export function setProxyKey(key: string) {
  const s = structuredClone(load());
  s.proxy.apiKeyEnc = encryptKey(key);
  s.proxy.enabled = true;
  persist(s);
}

/** До конца первой настройки пользователь ещё не видел предупреждения — ничего не отправляем. */
export function errorReportsAllowed(): boolean {
  const s = loadIfReadable();
  return Boolean(s?.onboarded && s.diagnostics);
}

/**
 * Статистика шагов идёт и до конца настройки: экран входа сразу предупреждает о ней, а без этих событий не видно,
 * где люди бросают настройку. Только installId, версия, ОС и имя шага; выключатель — на вкладке «Приложение».
 */
export function usageEventsAllowed(): boolean {
  return loadIfReadable()?.diagnostics ?? false;
}

/** Первый запуск на этой машине: настройка не пройдена и статистика ещё не заводила installId. */
export function usageFirstLaunch(): boolean {
  const s = loadIfReadable();
  return Boolean(s && !s.onboarded && !s.usageInstallId);
}

export function usageInstallId(): string {
  const s = load();
  if (s.usageInstallId) return s.usageInstallId;
  const next = { ...s, usageInstallId: randomUUID() };
  persist(next);
  return next.usageInstallId;
}

export function publicSettings(): PublicSettings {
  const stored = loadIfReadable();
  const s = stored ?? DEFAULTS;
  return {
    toolPaths: s.toolPaths,
    proxy: { baseUrl: s.proxy.baseUrl, codexBaseUrl: s.proxy.codexBaseUrl, hasKey: Boolean(s.proxy.apiKeyEnc), enabled: s.proxy.enabled },
    models: s.models,
    efforts: s.efforts,
    agents: s.agents,
    enabledAgents: s.enabledAgents,
    agentTimeoutMin: s.agentTimeoutMin,
    testTimeoutMin: s.testTimeoutMin,
    maxParallel: s.maxParallel,
    onboarded: s.onboarded,
    windowGlass: s.windowGlass,
    notify: s.notify,
    sound: s.sound,
    claudeAuth: s.claudeAuth,
    userConfig: s.userConfig,
    accountEnabled: ACCOUNT_ENABLED,
    account: ACCOUNT_ENABLED && s.account.tokenEnc ? { email: s.account.email, name: s.account.name, photo: s.account.photo } : null,
    authPrompted: s.authPrompted,
    diagnostics: stored?.diagnostics ?? false,
  };
}

export function coreSettings(): CoreSettings {
  const s = loadIfReadable() ?? DEFAULTS;
  const apiKey = s.proxy.enabled ? decryptKey(s.proxy.apiKeyEnc) : '';
  return {
    toolPaths: s.toolPaths,
    // Есть включённый ключ — агенты идут через AI-прокси; нет или выключен — через собственный вход claude и codex.
    proxy: {
      baseUrl: apiKey ? s.proxy.baseUrl.trim() || DEFAULT_PROXY.claude : '',
      codexBaseUrl: s.proxy.codexBaseUrl.trim() || DEFAULT_PROXY.codex,
      apiKey,
    },
    models: s.models,
    efforts: s.efforts,
    agents: s.agents,
    enabledAgents: s.enabledAgents,
    claudeAuth: s.claudeAuth,
    userConfig: s.userConfig,
    agentTimeoutMin: s.agentTimeoutMin,
    testTimeoutMin: s.testTimeoutMin,
    maxParallel: s.maxParallel,
  };
}

export function updateSettings(patch: SettingsPatch): PublicSettings {
  const s = structuredClone(load());
  if (patch.toolPaths) s.toolPaths = { ...s.toolPaths, ...patch.toolPaths };
  if (patch.models) s.models = { ...s.models, ...patch.models };
  if (patch.agents) s.agents = { ...s.agents, ...patch.agents };
  if (patch.efforts) {
    // '' — снова «как в CLI».
    s.efforts = { ...s.efforts, ...patch.efforts };
    for (const r of Object.keys(s.efforts) as Role[]) if (!s.efforts[r]) delete s.efforts[r];
  }
  if (patch.enabledAgents) s.enabledAgents = enabledAgents(patch);
  // Роли на выключенном CLI переходят на включённый — с его моделью по умолчанию: имя модели одного CLI другому не подходит.
  for (const slot of AGENT_SLOTS) {
    const a = s.agents[slot];
    if (a && !s.enabledAgents.includes(a)) {
      s.agents[slot] = s.enabledAgents[0];
      s.models[slot] = '';
    }
  }
  if (patch.proxy) {
    if (patch.proxy.baseUrl !== undefined) s.proxy.baseUrl = patch.proxy.baseUrl;
    if (patch.proxy.codexBaseUrl !== undefined) s.proxy.codexBaseUrl = patch.proxy.codexBaseUrl;
    if (patch.proxy.apiKey !== undefined) s.proxy.apiKeyEnc = encryptKey(patch.proxy.apiKey);
    if (patch.proxy.enabled !== undefined) s.proxy.enabled = patch.proxy.enabled;
  }
  if (patch.agentTimeoutMin !== undefined) s.agentTimeoutMin = patch.agentTimeoutMin;
  if (patch.testTimeoutMin !== undefined) s.testTimeoutMin = patch.testTimeoutMin;
  if (patch.maxParallel !== undefined) s.maxParallel = patch.maxParallel;
  if (patch.onboarded !== undefined) s.onboarded = patch.onboarded;
  if (patch.windowGlass !== undefined) s.windowGlass = patch.windowGlass;
  if (patch.notify !== undefined) s.notify = patch.notify;
  if (patch.sound !== undefined) s.sound = patch.sound;
  if (patch.claudeAuth !== undefined) s.claudeAuth = patch.claudeAuth;
  if (patch.userConfig !== undefined) s.userConfig = patch.userConfig;
  if (patch.authPrompted !== undefined) s.authPrompted = patch.authPrompted;
  if (patch.diagnostics !== undefined) s.diagnostics = patch.diagnostics;
  persist(s);
  return publicSettings();
}
