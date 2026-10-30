// Журнал ошибок, которые ядро сознательно не пробрасывает: фоновые задачи, уборка, запасные пути.
// Пишется в core.log каталога данных (не больше ~1 МБ), с PURPLEFLOW_DEBUG=1 — ещё и в stderr.
import fs from 'node:fs';

const MAX_BYTES = 1_000_000;
let file: string | null = null;

export function setTraceFile(path: string | null) {
  file = path;
}

export function trace(scope: string, e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  const line = `${new Date().toISOString()} [${scope}] ${text.replace(/\s+/g, ' ').slice(0, 2000)}\n`;
  if (process.env.PURPLEFLOW_DEBUG) process.stderr.write(line);
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      const tail = fs.readFileSync(file, 'utf8').slice(-MAX_BYTES / 2);
      fs.writeFileSync(file, tail.slice(tail.indexOf('\n') + 1));
    }
    fs.appendFileSync(file, line);
  } catch {
    /* журнал — не повод ронять ядро */
  }
}

/** Для .catch(): ошибка уходит в журнал, промис завершается undefined. */
export const traced =
  (scope: string) =>
  (e: unknown): undefined => {
    trace(scope, e);
    return undefined;
  };
