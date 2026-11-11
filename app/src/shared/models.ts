/**
 * Список моделей AI-прокси PurpleSchool (GET /public/ai-proxy/models, без ключа):
 * anthropic — для claude, openai — для codex. Новые модели появляются в выпадающих списках без нового выпуска.
 */
export interface ProxyModel {
  id: string;
  displayName: string;
}
export interface ProxyModels {
  anthropic: ProxyModel[];
  openai: ProxyModel[];
}

/** Ограничения на случай странного ответа: список не должен раздуть выпадающее меню. */
const MAX_MODELS = 100;
const MAX_LEN = 120;

function list(x: unknown): ProxyModel[] | null {
  if (!Array.isArray(x)) return null;
  const seen = new Set<string>();
  const out: ProxyModel[] = [];
  for (const m of x) {
    if (!m || typeof m !== 'object') continue;
    const { id, displayName } = m as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w.:/-]{1,120}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, displayName: typeof displayName === 'string' ? displayName.trim().slice(0, MAX_LEN) : '' });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** Ответ сервера или кэш с диска → проверенный список; что-то не то — null. */
export function parseProxyModels(x: unknown): ProxyModels | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const anthropic = list(o.anthropic);
  const openai = list(o.openai);
  if (!anthropic || !openai) return null;
  return { anthropic, openai };
}
