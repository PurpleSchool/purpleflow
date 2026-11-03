// Куски файла лога: попытка стадии и итоговый ответ агента.
/** Часть лога: одна попытка одной стадии (по заголовку «━━ Стадия · попытка N»). */
export interface LogSlice {
  title: string;
  attempt: number;
  /** Стадия в событиях agent.output — чтобы дописывать идущую попытку вживую. */
  stage: string;
  live: boolean;
}

export function cut(text: string, slice: Pick<LogSlice, 'title' | 'attempt'>): string {
  const head = `━━ ${slice.title} · попытка ${slice.attempt}`;
  // «попытка 1» не должна находить «попытка 10».
  let at = text.indexOf(head);
  while (at >= 0 && /\d/.test(text[at + head.length] ?? '')) at = text.indexOf(head, at + head.length);
  if (at < 0) return '';
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const next = text.indexOf('━━ ', at + head.length);
  const end = next < 0 ? text.length : text.lastIndexOf('\n', next) + 1;
  return text.slice(lineStart, end);
}

/**
 * Итоговый ответ агента из лога попытки (для прогонов, где он не сохранён в run.json):
 * последний сплошной кусок обычного текста — без цвета и приглушения, которыми выводятся вызовы инструментов.
 */
export function finalMessage(text: string): string {
  const parts: { plain: boolean; text: string }[] = [];
  let dim = false;
  let color = false;
  let bold = false;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string) => t && parts.push({ plain: !dim && !color && !bold, text: t });
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) dim = color = bold = false;
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) dim = bold = false;
      else if (c === 39) color = false;
      else if (c === 38) {
        color = true;
        i += codes[i + 1] === 2 ? 4 : 2;
      } else if (c >= 30 && c <= 37) color = true;
    }
  }
  push(text.slice(last));
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i].plain) {
      if (parts[i].text.trim()) break;
      continue;
    }
    out.unshift(parts[i].text);
  }
  return out.join('').replace(/\r/g, '').trim();
}
