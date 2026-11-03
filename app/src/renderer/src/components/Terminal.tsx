import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { onCoreEvent } from '../lib/store';
import { bridge } from '../lib/api';
import { cut, type LogSlice } from '../lib/logSlice';

const THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#c9cad0',
  cursor: '#8a74ee',
  cursorAccent: '#08090a',
  selectionBackground: 'rgba(138,116,238,0.3)',
  black: '#1d1e23',
  brightBlack: '#4d4f57',
  red: '#df7e8d',
  brightRed: '#ec9eaa',
  green: '#74c4a0',
  brightGreen: '#99d7ba',
  yellow: '#d6ad66',
  brightYellow: '#e4c58e',
  blue: '#84b4d6',
  brightBlue: '#a7cae3',
  magenta: '#b2a5f5',
  brightMagenta: '#cbc2f8',
  cyan: '#86c3c6',
  brightCyan: '#a9d6d8',
  white: '#c9cad0',
  brightWhite: '#ffffff',
};

export type { LogSlice } from '../lib/logSlice';

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

    bridge.core
      .getLog(runId)
      .catch(() => '')
      .then((full) => {
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
      } catch {
        /* терминал скрыт */
      }
    });
    ro.observe(host.current!);
    return () => {
      alive = false;
      off();
      ro.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- терминал пересоздаётся при смене попытки, а не при каждом новом объекте slice
  }, [runId, slice?.title, slice?.attempt, slice?.live]);

  // Отступы — у внешней обёртки: FitAddon меряет ширину родителя без учёта его padding.
  return (
    <div className="term">
      <div className="term-host" ref={host} />
    </div>
  );
}
