import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { PurpleFlowBridge } from '../src/shared/ipc';
import { launch, makeSandbox, quit, type Launched } from './harness';

type AppWindow = { purpleflow: PurpleFlowBridge };

test('временная ошибка чтения не стирает сохранённые настройки', async () => {
  test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'тест требует ограничения доступа через chmod');
  const box = makeSandbox({
    settings: {
      diagnostics: false,
      seenVersion: '999.0.0',
      maxParallel: 7,
      sound: true,
      proxy: { apiKeyEnc: 'fixture-key', enabled: false },
      account: { tokenEnc: 'fixture-token' },
    },
  });
  let launched: Launched | undefined;
  try {
    const file = path.join(box.profile, 'settings.json');
    const original = fs.readFileSync(file, 'utf8');
    fs.chmodSync(file, 0o000);
    expect(() => fs.readFileSync(file)).toThrow(/EACCES/);

    const l = await launch(box, { PURPLEFLOW_ACCOUNT: 'off', PURPLEFLOW_USAGE_EVENTS: 'off', PURPLEFLOW_ERROR_REPORTS: 'off' });
    launched = l;
    await l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.whatsNew.versions());
    expect(fs.statSync(file).mode & 0o777).toBe(0);
    await expect(l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.settings.set({ sound: false }))).rejects.toThrow(
      /EACCES/,
    );

    fs.chmodSync(file, 0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(box.profile).filter((name) => name.startsWith('settings.json.broken-'))).toEqual([]);

    const settings = await l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.settings.get());
    expect(settings).toMatchObject({ onboarded: true, maxParallel: 7 });
    await l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.settings.set({ sound: false }));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ ...JSON.parse(original), sound: false });
    expect(l.errors).toEqual([]);
  } finally {
    try {
      if (launched) await quit(launched);
    } finally {
      box.cleanup();
    }
  }
});
