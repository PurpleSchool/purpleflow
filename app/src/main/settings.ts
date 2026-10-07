import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { AgentKind, CoreSettings, Role } from '@psflow/core';
import type { PublicSettings, SettingsPatch } from '../shared/ipc';

interface StoredSettings {
  toolPaths: CoreSettings['toolPaths'];
  proxy: { baseUrl: string; codexBaseUrl: string; apiKeyEnc: string };
  models: CoreSettings['models'];
  agents: Record<Role, AgentKind>;
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
}

const DEFAULTS: StoredSettings = {
  toolPaths: {},
  proxy: { baseUrl: '', codexBaseUrl: '', apiKeyEnc: '' },
  models: { planner: 'opus', executor: 'sonnet', reviewer: '', visual: '' },
  agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
  agentTimeoutMin: 30,
  maxParallel: 2,
  testTimeoutMin: 10,
  onboarded: false,
  windowGlass: true,
  notify: true,
  sound: true,
  claudeAuth: 'login',
};

/**
 * Адрес прокси PurpleSchool. В интерфейсе вводится только токен; адрес можно переопределить
 * переменной PSFLOW_PROXY_URL или старым полем baseUrl в settings.json.
 */
const PURPLESCHOOL_PROXY = process.env.PSFLOW_PROXY_URL || 'https://proxy.purpleschool.ru';

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

/** Ключ прокси хранится только зашифрованным через safeStorage (Keychain / DPAPI / libsecret). */
function decryptKey(enc: string): string {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

export function publicSettings(): PublicSettings {
  const s = load();
  return {
    toolPaths: s.toolPaths,
    proxy: { baseUrl: s.proxy.baseUrl, codexBaseUrl: s.proxy.codexBaseUrl, hasKey: Boolean(s.proxy.apiKeyEnc) },
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
  };
}

export function coreSettings(): CoreSettings {
  const s = load();
  const apiKey = decryptKey(s.proxy.apiKeyEnc);
  return {
    toolPaths: s.toolPaths,
    // Есть токен — агенты идут через прокси PurpleSchool; нет — через собственный вход claude и codex.
    proxy: { baseUrl: apiKey ? s.proxy.baseUrl.trim() || PURPLESCHOOL_PROXY : '', codexBaseUrl: s.proxy.codexBaseUrl.trim(), apiKey },
    models: s.models,
    agents: s.agents,
    claudeAuth: s.claudeAuth,
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
    if (patch.proxy.apiKey !== undefined) {
      if (!patch.proxy.apiKey) s.proxy.apiKeyEnc = '';
      else {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Шифрование хранилища недоступно в этой системе — ключ не сохранён');
        s.proxy.apiKeyEnc = safeStorage.encryptString(patch.proxy.apiKey).toString('base64');
      }
    }
  }
  if (patch.agentTimeoutMin !== undefined) s.agentTimeoutMin = patch.agentTimeoutMin;
  if (patch.testTimeoutMin !== undefined) s.testTimeoutMin = patch.testTimeoutMin;
  if (patch.maxParallel !== undefined) s.maxParallel = patch.maxParallel;
  if (patch.onboarded !== undefined) s.onboarded = patch.onboarded;
  if (patch.windowGlass !== undefined) s.windowGlass = patch.windowGlass;
  if (patch.notify !== undefined) s.notify = patch.notify;
  if (patch.sound !== undefined) s.sound = patch.sound;
  if (patch.claudeAuth !== undefined) s.claudeAuth = patch.claudeAuth;
  persist(s);
  return publicSettings();
}
