// Мост к main-процессу и ядру (preload, window.purpleflow). Окно обращается к нему только через этот модуль:
// одно место, где видно, что экраны берут из main, и где мост можно подменить.
export const bridge = window.purpleflow;

/** Текст ошибки вызова ядра без служебного префикса Electron «Error invoking remote method …». */
export const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
