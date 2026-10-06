import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { CoreSettings } from '@psflow/core';
import type { PublicSettings, SettingsPatch } from '../shared/ipc';

interface StoredSettings {
  toolPaths: CoreSettings['toolPaths'];
  proxy: { baseUrl: string; codexBaseUrl: string; apiKeyEnc: string };
  models: CoreSettings['models'];
  agentTimeoutMin: number;
  testTimeoutMin: number;
  onboarded: boolean;
  windowGlass: boolean;
}

const DEFAULTS: StoredSettings = {
  toolPaths: {},
  proxy: { baseUrl: '', codexBaseUrl: '', apiKeyEnc: '' },
  models: { planner: 'opus', executor: 'sonnet', reviewer: '' },
  agentTimeoutMin: 30,
  testTimeoutMin: 10,
  onboarded: false,
  windowGlass: true,
};

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
    agentTimeoutMin: s.agentTimeoutMin,
    testTimeoutMin: s.testTimeoutMin,
    onboarded: s.onboarded,
    windowGlass: s.windowGlass,
  };
}

export function coreSettings(): CoreSettings {
  const s = load();
  return {
    toolPaths: s.toolPaths,
    proxy: { baseUrl: s.proxy.baseUrl.trim(), codexBaseUrl: s.proxy.codexBaseUrl.trim(), apiKey: decryptKey(s.proxy.apiKeyEnc) },
    models: s.models,
    agentTimeoutMin: s.agentTimeoutMin,
    testTimeoutMin: s.testTimeoutMin,
  };
}

export function updateSettings(patch: SettingsPatch): PublicSettings {
  const s = structuredClone(load());
  if (patch.toolPaths) s.toolPaths = { ...s.toolPaths, ...patch.toolPaths };
  if (patch.models) s.models = { ...s.models, ...patch.models };
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
  if (patch.onboarded !== undefined) s.onboarded = patch.onboarded;
  if (patch.windowGlass !== undefined) s.windowGlass = patch.windowGlass;
  persist(s);
  return publicSettings();
}
