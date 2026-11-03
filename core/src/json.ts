/** Где в ответе может быть JSON. Блоков кода бывает несколько: ответ обычно в последнем, перед ним — примеры кода. */
export function jsonCandidates(text: string): string[] {
  const fences = [...text.matchAll(/```(?:\w+)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim()).reverse();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  return [text.trim(), ...fences, ...(a >= 0 && b > a ? [text.slice(a, b + 1)] : [])];
}

/**
 * JSON из ответа агента: чистый JSON, блок ```json, либо первый «{» … последний «}».
 * Агенты часто обрамляют ответ текстом — один разбор на всё ядро вместо десятка ручных.
 */
export function parseJsonReply<T = Record<string, unknown>>(text: string): T | null {
  for (const c of jsonCandidates(text)) {
    try {
      const j = JSON.parse(c) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as T;
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}
