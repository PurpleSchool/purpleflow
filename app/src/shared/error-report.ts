/**
 * Очистка отчёта об ошибке перед отправкой. В текстах ошибок бывают пути к проектам, адреса, ключи —
 * наружу уходят только тип ошибки, стек кода приложения и сведения о версии и системе.
 */

interface Frame {
  filename?: string;
  abs_path?: string;
  module?: string;
  vars?: unknown;
  context_line?: string;
  pre_context?: unknown;
  post_context?: unknown;
}

interface ExceptionValue {
  value?: string;
  stacktrace?: { frames?: Frame[] };
}

export interface ScrubbableEvent {
  message?: string;
  transaction?: string;
  server_name?: string;
  user?: unknown;
  breadcrumbs?: unknown;
  extra?: unknown;
  request?: unknown;
  exception?: { values?: ExceptionValue[] };
  contexts?: { device?: { name?: unknown } | null } | null;
}

const MAX_TEXT = 500;

export function scrubText(text: string): string {
  const clean = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\bBearer\s+[^\s'"`]+/gi, 'Bearer <secret>')
    .replace(/\b(?:sk|pk|rk)-[\w-]{8,}/g, '<secret>')
    .replace(/\bgh[pousr]_\w{8,}/g, '<secret>')
    .replace(/\b(api[_-]?key|token|secret|password|passwd)(["']?\s*[=:]\s*["']?)[^\s'"`,;&]+/gi, '$1$2<secret>')
    .replace(/\b[A-Za-z]:\\[^\s'"`<>]+/g, '<path>')
    .replace(/(^|[\s'"`(=:])~?\/(?:[^\s/'"`()<>:]+\/)*[^\s/'"`()<>:]+/g, '$1<path>');
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
}

const stripHome = (value: string, home: string) => (home ? value.split(home).join('~') : value);

/** Меняет отчёт на месте и его же возвращает. home — домашняя папка: в стеке вместо неё остаётся «~». */
export function scrubEvent<T extends ScrubbableEvent>(event: T, home: string): T {
  delete event.server_name;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.request;
  delete event.transaction;
  if (event.contexts?.device) delete event.contexts.device.name;
  if (event.message) event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = stripHome(frame.filename, home);
      if (frame.abs_path) frame.abs_path = stripHome(frame.abs_path, home);
      if (frame.module) frame.module = stripHome(frame.module, home);
      delete frame.vars;
      delete frame.context_line;
      delete frame.pre_context;
      delete frame.post_context;
    }
  }
  return event;
}
