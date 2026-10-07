import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { onCoreEvent } from '../lib/store';

const THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#c9cad0',
  cursor: '#8a74ee',
  cursorAccent: '#08090a',
  selectionBackground: 'rgba(138,116,238,0.3)',
  black: '#1d1e23', brightBlack: '#4d4f57',
  red: '#df7e8d', brightRed: '#ec9eaa',
  green: '#74c4a0', brightGreen: '#99d7ba',
  yellow: '#d6ad66', brightYellow: '#e4c58e',
  blue: '#84b4d6', brightBlue: '#a7cae3',
  magenta: '#b2a5f5', brightMagenta: '#cbc2f8',
  cyan: '#86c3c6', brightCyan: '#a9d6d8',
  white: '#c9cad0', brightWhite: '#ffffff',
};

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
  const at = text.indexOf(head);
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
      else if (c === 38) { color = true; i += codes[i + 1] === 2 ? 4 : 2; }
      else if (c >= 30 && c <= 37) color = true;
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

/** Живой лог прогона: история из файла лога + поток agent.output. С slice — только одна попытка. */
export function LiveLog({ runId, slice }: { runId: string; slice?: LogSlice }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new XTerm({
      theme: THEME,
      fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.6,
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
      allowTransparency: true,
      scrollback: 20000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    let alive = true;
    const queue: string[] = [];
    let loaded = false;

    const off = onCoreEvent((e) => {
      if (e.type !== 'agent.output' || e.runId !== runId) return;
      if (slice && (!slice.live || e.stage !== slice.stage)) return;
      if (loaded) term.write(e.text);
      else queue.push(e.text);
    });

    void window.psflow.core.getLog(runId).then((full) => {
      if (!alive) return;
      const text = slice ? cut(full, slice) : full;
      term.write(text);
      // События, пришедшие во время загрузки, уже есть в файле лога, кроме самых свежих — дописываем хвост без повторов.
      const tail = queue.join('');
      if (tail && !text.endsWith(tail)) term.write(tail);
      loaded = true;
      requestAnimationFrame(() => fit.fit());
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch { /* терминал скрыт */ }
    });
    ro.observe(host.current!);
    return () => {
      alive = false;
      off();
      ro.disconnect();
      term.dispose();
    };
  }, [runId, slice?.title, slice?.attempt, slice?.live]);

  // Отступы — у внешней обёртки: FitAddon меряет ширину родителя без учёта его padding.
  return (
    <div className="term">
      <div className="term-host" ref={host} />
    </div>
  );
}
