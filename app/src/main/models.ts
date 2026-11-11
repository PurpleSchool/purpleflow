import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { parseProxyModels, type ProxyModels } from '../shared/models';
import { ACCOUNT_API, ACCOUNT_ENABLED } from './provider';

/**
 * Список моделей AI-прокси для выпадающих списков. Публичный адрес, без ключа и без данных пользователя.
 * Ответ кэшируется на диске: без сети и при ошибке сервера окно получает последний удачный список,
 * а если его нет — null, и окно показывает встроенный.
 */
const TTL_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 8_000;
const file = () => path.join(app.getPath('userData'), 'proxy-models.json');

let memo: { at: number; models: ProxyModels } | null = null;
let inflight: Promise<ProxyModels | null> | null = null;

function readCache(): ProxyModels | null {
  try {
    return parseProxyModels(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return null;
  }
}

async function load(): Promise<ProxyModels | null> {
  try {
    const res = await fetch(`${ACCOUNT_API}/public/ai-proxy/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const models = res.ok ? parseProxyModels(await res.json()) : null;
    if (models) {
      memo = { at: Date.now(), models };
      try {
        fs.writeFileSync(file(), JSON.stringify(models));
      } catch {
        /* без кэша на диске — список всё равно есть в памяти */
      }
      return models;
    }
  } catch {
    /* сеть или сервер недоступны — ниже кэш */
  }
  return memo?.models ?? readCache();
}

export function proxyModels(): Promise<ProxyModels | null> {
  if (!ACCOUNT_ENABLED) return Promise.resolve(null);
  if (memo && Date.now() - memo.at < TTL_MS) return Promise.resolve(memo.models);
  inflight ??= load().finally(() => (inflight = null));
  return inflight;
}
