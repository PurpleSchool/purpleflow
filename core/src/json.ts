/**
 * JSON из ответа агента: чистый JSON, блок ```json, либо первый «{» … последний «}».
 * Агенты часто обрамляют ответ текстом — один разбор на всё ядро вместо десятка ручных.
 */
export function parseJsonReply<T = Record<string, unknown>>(text: string): T | null {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as T;
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}
