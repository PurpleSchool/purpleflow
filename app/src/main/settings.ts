import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { AgentKind, CoreSettings, Role } from '@purpleflow/core';
import type { PublicSettings, SettingsPatch } from '../shared/ipc';

interface StoredSettings {
  toolPaths: CoreSettings['toolPaths'];
  /** enabled: false — ключ сохранён, но агенты работают по своим подпискам. */
  proxy: { baseUrl: string; codexBaseUrl: string; apiKeyEnc: string; enabled: boolean };
  models: CoreSettings['models'];
  /** Роли конвейера; visual — по умолчанию claude, manager — claude, если установлен, иначе codex. */
  agents: Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind };
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
}

const DEFAULTS: StoredSettings = {
  toolPaths: {},
  proxy: { baseUrl: '', codexBaseUrl: '', apiKeyEnc: '', enabled: true },
  models: { planner: 'opus', executor: 'sonnet', reviewer: '', visual: '', manager: '' },
  agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
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
};

/**
 * Адреса AI-прокси PurpleSchool — как в официальной инструкции подключения (GET /public/ai-proxy/setup-instructions):
 * claude — Anthropic API, codex — OpenAI Responses API. Переопределяются переменными PURPLEFLOW_PROXY_URL и
 * PURPLEFLOW_CODEX_PROXY_URL или полями baseUrl и codexBaseUrl в settings.json.
 */
const PURPLESCHOOL_PROXY = process.env.PURPLEFLOW_PROXY_URL || 'https://app.purpleschool.ru/api-v2/public/ai-proxy/anthropic';
const PURPLESCHOOL_CODEX_PROXY = process.env.PURPLEFLOW_CODEX_PROXY_URL || 'https://app.purpleschool.ru/api-v2/public/ai-proxy/openai/v1';

const file = () => path.join(app.getPath('userData'), 'settings.json');

let cache: StoredSettings | null = null;

function load(): StoredSettings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<StoredSettings>;
    cache = {
      ...DEFAULTS,
      ...raw,
      proxy: { ...DEFAULTS.proxy, ...raw.proxy },
      account: { ...DEFAULTS.account, ...raw.account },
      models: { ...DEFAULTS.models, ...raw.models },
      agents: { ...DEFAULTS.agents, ...raw.agents },
      toolPaths: { ...raw.toolPaths },
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function persist(s: StoredSettings) {
  cache = s;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
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

/** Токен аккаунта PurpleSchool — только для main: в окно он не уходит. */
export function accountToken(): string {
  return decryptKey(load().account.tokenEnc);
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
  return decryptKey(load().proxy.apiKeyEnc);
}

export function setProxyKey(key: string) {
  const s = structuredClone(load());
  s.proxy.apiKeyEnc = encryptKey(key);
  s.proxy.enabled = true;
  persist(s);
}

export function publicSettings(): PublicSettings {
  const s = load();
  return {
    toolPaths: s.toolPaths,
    proxy: { baseUrl: s.proxy.baseUrl, codexBaseUrl: s.proxy.codexBaseUrl, hasKey: Boolean(s.proxy.apiKeyEnc), enabled: s.proxy.enabled },
    models: s.models,
    agents: s.agents,
    agentTimeoutMin: s.agentTimeoutMin,
    testTimeoutMin: s.testTimeoutMin,
    maxParallel: s.maxParallel,
    onboarded: s.onboarded,
    windowGlass: s.windowGlass,
    notify: s.notify,
    sound: s.sound,
    claudeAuth: s.claudeAuth,
    userConfig: s.userConfig,
    account: s.account.tokenEnc ? { email: s.account.email, name: s.account.name, photo: s.account.photo } : null,
    authPrompted: s.authPrompted,
  };
}

export function coreSettings(): CoreSettings {
  const s = load();
  const apiKey = s.proxy.enabled ? decryptKey(s.proxy.apiKeyEnc) : '';
  return {
    toolPaths: s.toolPaths,
    // Есть включённый ключ — агенты идут через прокси PurpleSchool; нет или выключен — через собственный вход claude и codex.
    proxy: { baseUrl: apiKey ? s.proxy.baseUrl.trim() || PURPLESCHOOL_PROXY : '', codexBaseUrl: s.proxy.codexBaseUrl.trim() || PURPLESCHOOL_CODEX_PROXY, apiKey },
    models: s.models,
    agents: s.agents,
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
  persist(s);
  return publicSettings();
}
