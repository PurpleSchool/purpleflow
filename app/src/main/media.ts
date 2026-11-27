// MCP PurpleSchool для картинок (позже — видео и озвучка): список моделей для настроек и загрузка готовых картинок для
// чата. Запросы — из main: ключ аккаунта не попадает в окно, а CSP окна не пускает внешние картинки напрямую.
import { ACCOUNT_ENABLED, MEDIA_MCP_URL } from './provider';
import { proxyKey } from './settings';
import type { AccountResult, MediaModel } from '../shared/ipc';

const TIMEOUT_MS = 20_000;

/** Один вызов MCP по Streamable HTTP: initialize → вызов. Ответ — JSON или события SSE с одним сообщением. */
async function mcp<T>(key: string, method: string, params: unknown): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(MEDIA_MCP_URL, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const read = async (r: Response) => {
    const t = await r.text();
    const data = t.includes('data:')
      ? t
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
      : t;
    return data ? (JSON.parse(data) as { result?: T; error?: { message?: string } }) : {};
  };
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'PurpleFlow', version: '1' } },
  });
  if (init.status === 401 || init.status === 403) throw new Error('Ключ аккаунта не подошёл — выберите или создайте ключ ниже.');
  if (!init.ok) throw new Error(`Сервер картинок PurpleSchool не отвечает (${init.status}).`);
  await read(init);
  const sid = init.headers.get('mcp-session-id');
  const session: Record<string, string> = sid ? { 'Mcp-Session-Id': sid } : {};
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  const r = await read(await post({ jsonrpc: '2.0', id: 2, method, params }, session));
  if (r.error) throw new Error(r.error.message || 'Ошибка сервера картинок');
  return r.result as T;
}

interface ToolList {
  tools?: { name: string; inputSchema?: { properties?: { model?: { enum?: string[]; default?: string } } } }[];
}
interface CallResult {
  structuredContent?: { models?: { id?: string; model?: string; name?: string; prices?: Record<string, number>; price?: number }[] };
}

/** Модели картинок, доступные по ключу аккаунта: из схемы generate_image, цены — из list_models, если он их отдаёт. */
export async function mediaModels(): Promise<AccountResult<{ models: MediaModel[]; default: string | null }>> {
  if (!ACCOUNT_ENABLED) return { ok: false, error: 'Аккаунт PurpleSchool отключён в этой сборке' };
  const key = proxyKey();
  if (!key) return { ok: false, error: 'Нет ключа аккаунта — выберите или создайте его ниже.' };
  try {
    const list = await mcp<ToolList>(key, 'tools/list', {});
    const model = list.tools?.find((t) => t.name === 'generate_image')?.inputSchema?.properties?.model;
    const ids = model?.enum ?? [];
    // Цены — необязательны: сервер может их не отдать, модели от этого не пропадают.
    const priced = await mcp<CallResult>(key, 'tools/call', { name: 'list_models', arguments: { type: 'image' } }).catch(() => null);
    const prices = new Map<string, number>();
    for (const m of priced?.structuredContent?.models ?? []) {
      const id = m.id ?? m.model ?? m.name;
      const price = m.prices?.['1K'] ?? m.price;
      if (id && typeof price === 'number') prices.set(id, price);
    }
    return { ok: true, data: { models: ids.map((id) => ({ id, price: prices.get(id) })), default: model?.default ?? null } };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'Сервер картинок PurpleSchool не ответил вовремя.' : (e as Error).message;
    return { ok: false, code: 'network', error: msg };
  }
}

const MEDIA_MAX = 25 * 1024 * 1024;

/** Готовая картинка (или видео) по ссылке из ответа MCP — байтами для окна. Только https и только медиа. */
export async function fetchMedia(url: string): Promise<{ mime: string; data: Uint8Array } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // https; http — только с этой машины (локальный сервер разработки, e2e).
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
    const mime = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !/^(image|video)\//.test(mime) || mime === 'image/svg+xml') return null;
    if (Number(r.headers.get('content-length') ?? 0) > MEDIA_MAX) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    return buf.length > MEDIA_MAX ? null : { mime, data: buf };
  } catch {
    return null;
  }
}
