import type { AccountKey, AccountResult } from '../shared/ipc';
import { accountToken, proxyKey, setAccount, setProxyKey } from './settings';

/**
 * Аккаунт PurpleSchool: вход, регистрация и ключи AI-прокси.
 * Запросы идут из main-процесса на машине пользователя — лимит частоты /auth/* считается по его IP,
 * а токен аккаунта не попадает в окно. Токен бессрочный и даёт полный доступ: не логируем и не кладём в URL.
 */
const API = (process.env.PSFLOW_API_URL || 'https://app.purpleschool.ru/api-v2').replace(/\/+$/, '');
const KEY_NAME = 'PurpleFlow';
const TIMEOUT_MS = 20_000;

type Fail = Extract<AccountResult, { ok: false }>;

interface ApiKeyView {
  id: number;
  name: string;
  proxyKey: string;
  effectiveStatus: 'ACTIVE' | 'DEACTIVATED' | 'EXPIRED';
  createdAt: string;
  lastUsedAt: string | null;
}

const normEmail = (e: string) => e.trim().toLowerCase();

async function request<T>(method: 'GET' | 'POST', route: string, body?: unknown, token?: string): Promise<{ ok: true; data: T } | (Fail & { status?: number })> {
  let res: Response;
  try {
    res = await fetch(`${API}${route}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'network', error: 'Нет связи с PurpleSchool. Проверьте интернет и попробуйте ещё раз.' };
  }
  const json = (await res.json().catch(() => null)) as (T & { message?: string | string[] }) | null;
  if (res.ok) return { ok: true, data: json as T };
  const message = Array.isArray(json?.message) ? '' : (json?.message ?? '');
  if (res.status === 429) return { ok: false, status: 429, code: 'rate', error: 'Слишком много попыток. Подождите минуту и попробуйте снова.' };
  if (res.status >= 500) return { ok: false, status: res.status, error: 'Сервер PurpleSchool сейчас не отвечает. Попробуйте чуть позже.' };
  return { ok: false, status: res.status, error: /[а-яё]/i.test(message) ? message : '' };
}

/** Email из токена — подпись «Вы вошли как …»; подпись токена не проверяем, это делает сервер. */
function tokenEmail(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string };
    return payload.email ?? '';
  } catch {
    return '';
  }
}

function signedIn(token: string | undefined, email: string, name?: string): AccountResult {
  if (!token) return { ok: false, error: 'PurpleSchool не вернул токен. Попробуйте ещё раз.' };
  setAccount({ token, email: tokenEmail(token) || email, name });
  return { ok: true, data: null };
}

export async function login(email: string, password: string): Promise<AccountResult> {
  const r = await request<{ accessToken: string }>('POST', '/auth/login', { email: normEmail(email), password });
  if (!r.ok) {
    if (r.status === 401) return { ok: false, error: 'Неверный email или пароль' };
    if (r.status === 400) return { ok: false, error: 'Проверьте email: похоже, в нём ошибка' };
    return { ok: false, code: r.code, error: r.error || 'Не удалось войти' };
  }
  return signedIn(r.data?.accessToken, normEmail(email));
}

export async function register(p: { name: string; email: string; password: string; mailing: boolean }): Promise<AccountResult> {
  const email = normEmail(p.email);
  const r = await request<{ accessToken: string }>('POST', '/auth/register', {
    name: p.name.trim(),
    email,
    password: p.password,
    utm_source: 'purpleflow',
    needAdvertisingMailing: p.mailing,
  });
  if (!r.ok) {
    if (r.status === 400 && /существует/i.test(r.error)) return { ok: false, code: 'exists', error: 'Пользователь с таким email уже есть — войдите в аккаунт' };
    if (r.status === 400) return { ok: false, error: r.error || 'Проверьте имя и email' };
    return { ok: false, code: r.code, error: r.error || 'Не удалось зарегистрироваться' };
  }
  return signedIn(r.data?.accessToken, email, p.name.trim());
}

export async function restore(email: string): Promise<AccountResult<string>> {
  const r = await request<{ message?: string }>('POST', '/auth/restore', { email: normEmail(email) });
  if (!r.ok) return { ok: false, code: r.code, error: r.status === 400 ? 'Проверьте email: похоже, в нём ошибка' : r.error || 'Не удалось отправить письмо' };
  return { ok: true, data: r.data?.message || 'Если такой аккаунт есть, мы отправили письмо со ссылкой для смены пароля.' };
}

export function logout() {
  setAccount(null);
}

/** Запрос с токеном аккаунта; 401 — токен отозван: выходим, окно покажет вход. */
async function authed<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ ok: true; data: T } | Fail> {
  const token = accountToken();
  if (!token) return { ok: false, code: 'unauthorized', error: 'Войдите в аккаунт PurpleSchool' };
  const r = await request<T>(method, route, body, token);
  if (r.ok) return r;
  if (r.status === 401) {
    setAccount(null);
    return { ok: false, code: 'unauthorized', error: 'Сессия PurpleSchool закончилась — войдите снова' };
  }
  return { ok: false, code: r.code, error: r.error || 'PurpleSchool не выполнил запрос' };
}

async function listKeys() {
  return authed<{ items: ApiKeyView[]; activeKeysLimit: number }>('GET', '/public/ai-proxy/api-keys?sortBy=createdAt&sortDirection=desc');
}

export async function keys(): Promise<AccountResult<{ items: AccountKey[]; limit: number }>> {
  const r = await listKeys();
  if (!r.ok) return r;
  const current = proxyKey();
  return {
    ok: true,
    data: {
      limit: r.data.activeKeysLimit,
      items: r.data.items.map((k) => ({
        id: k.id,
        name: k.name,
        tail: k.proxyKey.slice(-4),
        active: k.effectiveStatus === 'ACTIVE',
        current: Boolean(current) && k.proxyKey === current,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    },
  };
}

export async function createKey(): Promise<AccountResult> {
  const r = await authed<ApiKeyView>('POST', '/public/ai-proxy/api-keys', { name: KEY_NAME });
  if (!r.ok) return r;
  if (!r.data?.proxyKey) return { ok: false, error: 'PurpleSchool не вернул ключ. Попробуйте ещё раз.' };
  setProxyKey(r.data.proxyKey);
  return { ok: true, data: null };
}

export async function useKey(id: number): Promise<AccountResult> {
  const r = await listKeys();
  if (!r.ok) return r;
  const k = r.data.items.find((x) => x.id === id && x.effectiveStatus === 'ACTIVE');
  if (!k) return { ok: false, error: 'Ключ не найден или уже не активен' };
  setProxyKey(k.proxyKey);
  return { ok: true, data: null };
}

/** После входа: свой ключ не трогаем; его нет — подставляем активный из аккаунта, ключ PurpleFlow первым. */
export async function autoKey(): Promise<AccountResult<'kept' | 'picked' | 'none'>> {
  if (proxyKey()) return { ok: true, data: 'kept' };
  const r = await listKeys();
  if (!r.ok) return r;
  const active = r.data.items.filter((k) => k.effectiveStatus === 'ACTIVE');
  const k = active.find((x) => x.name === KEY_NAME) ?? active[0];
  if (!k) return { ok: true, data: 'none' };
  setProxyKey(k.proxyKey);
  return { ok: true, data: 'picked' };
}
