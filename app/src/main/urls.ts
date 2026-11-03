// Куда можно уходить окну и вкладке «Браузер». Без Electron — чтобы проверялось тестами.

/** Адрес на этой машине: вкладка «Браузер» показывает только приложение проекта. */
export function isLocalUrl(u: string): boolean {
  try {
    const { protocol, hostname } = new URL(u);
    return /^https?:$/.test(protocol) && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

/** Ссылка, которую можно отдать системному браузеру. */
export function isWebUrl(u: string): boolean {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
}

/**
 * Переход главного окна допустим только внутри уже открытой страницы (перезагрузка, якорь):
 * у чужой страницы в этом окне был бы весь window.purpleflow.
 */
export function isSameDocument(target: string, current: string): boolean {
  try {
    const a = new URL(target);
    const b = new URL(current);
    return a.origin === b.origin && a.pathname === b.pathname && a.protocol === b.protocol;
  } catch {
    return false;
  }
}
