// Порты и ожидание запуска приложения для визуальной проверки и превью.

import net from 'node:net';

/**
 * PORT для команды запуска — только если в ней нет {port}: иначе порт уже передан нужному процессу явно,
 * а общий PORT подхватили бы все процессы команды (например, API вместе с фронтом) и столкнулись на одном порту.
 */
export function portEnv(runCommand: string, port: number): Record<string, string> {
  return /\{port(:[\w-]+)?\}/.test(runCommand) ? {} : { PORT: String(port) };
}

/**
 * Подставить свободные порты: {port} — порт приложения, {port:имя} — дополнительные (API, воркер…),
 * у каждого прогона свои — параллельные прогоны не делят один порт и не ходят в чужой API.
 */
export async function expandPorts(url: string, command: string): Promise<{ port: number; url: string; command: string }> {
  const used = new Set<number>();
  const take = async () => {
    for (let i = 0; i < 20; i++) {
      const p = await freePort();
      if (!used.has(p)) return (used.add(p), p);
    }
    throw new Error('Не нашлось свободных портов');
  };
  const port = await take();
  const named = new Map<string, number>();
  for (const m of `${url} ${command}`.matchAll(/\{port:([a-z0-9_-]+)\}/gi)) {
    if (!named.has(m[1])) named.set(m[1], await take());
  }
  const fill = (t: string) =>
    t.replace(/\{port:([a-z0-9_-]+)\}/gi, (_, n: string) => String(named.get(n))).replaceAll('{port}', String(port));
  return { port, url: fill(url), command: fill(command) };
}

/** Свободный TCP-порт на localhost. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Ждём, пока адрес начнёт отвечать (любой HTTP-ответ), или пока процесс не умрёт. */
export async function waitForUrl(url: string, timeoutMs: number, abort: () => boolean): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (abort()) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(timer);
      return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
