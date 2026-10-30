import fs from 'node:fs';
import { app, type BrowserWindow } from 'electron';

/**
 * Dev-инструмент: PURPLEFLOW_CAPTURE=out.png [PURPLEFLOW_CAPTURE_JS="…"] [PURPLEFLOW_CAPTURE_DELAY=ms] —
 * выполнить JS в окне, снять скриншот и выйти. Используется для визуальной проверки без ручного кликанья.
 */
export function setupCapture(w: BrowserWindow) {
  w.webContents.once('did-finish-load', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(Number(process.env.PURPLEFLOW_CAPTURE_DELAY ?? 2500));
    const shots = (process.env.PURPLEFLOW_CAPTURE ?? '').split(',');
    const scripts = (process.env.PURPLEFLOW_CAPTURE_JS ?? '').split('|||');
    for (let i = 0; i < shots.length; i++) {
      if (scripts[i]) {
        await w.webContents.executeJavaScript(scripts[i]).catch((e) => console.error('[capture]', e));
        await wait(Number(process.env.PURPLEFLOW_CAPTURE_STEP ?? 1500));
      }
      const img = await w.webContents.capturePage();
      fs.writeFileSync(shots[i], img.toPNG());
    }
    if (!process.env.PURPLEFLOW_CAPTURE_KEEP) app.quit();
  });
}
