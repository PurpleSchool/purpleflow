import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { onCoreEvent } from '../lib/store';

const THEME = {
  background: '#0c0a16',
  foreground: '#d9d4f2',
  cursor: '#8d6bff',
  cursorAccent: '#0c0a16',
  selectionBackground: 'rgba(141,107,255,0.35)',
  black: '#1e1935', brightBlack: '#5f5884',
  red: '#ff7390', brightRed: '#ff9bb0',
  green: '#55e2b4', brightGreen: '#8af0cd',
  yellow: '#ffc163', brightYellow: '#ffd796',
  blue: '#78cbff', brightBlue: '#a6dcff',
  magenta: '#b8a3ff', brightMagenta: '#d4c8ff',
  cyan: '#6fe3e9', brightCyan: '#a3f0f3',
  white: '#d9d4f2', brightWhite: '#ffffff',
};

/** Живой лог прогона: история из файла лога + поток agent.output. */
export function LiveLog({ runId }: { runId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new XTerm({
      theme: THEME,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.45,
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
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
      if (loaded) term.write(e.text);
      else queue.push(e.text);
    });

    void window.psflow.core.getLog(runId).then((text) => {
      if (!alive) return;
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
  }, [runId]);

  return <div className="term" ref={host} />;
}
