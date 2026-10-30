// Трансляция экрана браузера агента (Chrome DevTools Protocol, Page.startScreencast) во вкладку «Браузер».
import fs from 'node:fs';
import path from 'node:path';

/** Установленный Chrome / Chromium — тот же, что берёт Playwright CLI. null — не найден. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : process.platform === 'win32'
        ? [
            path.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
            path.join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
            path.join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/** Дождаться, пока Chrome откроет порт отладки. */
export async function waitForCdp(port: number, timeoutMs = 20_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Следит за вкладкой, с которой работает агент, и шлёт кадры не чаще раза в minIntervalMs.
 * Только чтение экрана: ввод в браузер агента не передаётся.
 */
export class Screencast {
  private ws: WebSocket | null = null;
  private target: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;
  private msgId = 0;
  private stopped = false;

  constructor(
    private port: number,
    private onFrame: (frame: { data: string; url: string; width: number; height: number }) => void,
    private minIntervalMs = 250,
  ) {}

  start() {
    void this.pick();
    // Агент может открыть новую вкладку или перейти по ссылке — переподключаемся к актуальной.
    this.timer = setInterval(() => void this.pick(), 1500);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* уже закрыт */
    }
    this.ws = null;
  }

  private url = '';

  private async pick() {
    if (this.stopped) return;
    let list: Target[];
    try {
      list = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as Target[];
    } catch {
      return;
    }
    const pages = list.filter((t) => t.type === 'page' && !/^(chrome|devtools|chrome-extension):/.test(t.url));
    const page = pages[0];
    if (!page?.webSocketDebuggerUrl) return;
    this.url = page.url;
    if (page.id === this.target && this.ws) return;
    this.target = page.id;
    try {
      this.ws?.close();
    } catch {
      /* старое соединение */
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    this.ws = ws;
    const send = (method: string, params: object = {}) => ws.send(JSON.stringify({ id: ++this.msgId, method, params }));
    ws.addEventListener('open', () =>
      send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 2880, maxHeight: 2000, everyNthFrame: 1 }),
    );
    ws.addEventListener('message', (ev) => {
      let m: { method?: string; params?: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } } };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.method !== 'Page.screencastFrame' || !m.params) return;
      send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
      const now = Date.now();
      if (now - this.lastFrame < this.minIntervalMs) return;
      this.lastFrame = now;
      this.onFrame({
        data: m.params.data,
        url: this.url,
        width: m.params.metadata?.deviceWidth ?? 0,
        height: m.params.metadata?.deviceHeight ?? 0,
      });
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.target = null;
      }
    });
    ws.addEventListener('error', () => {
      /* переподключимся на следующем опросе */
    });
  }
}
