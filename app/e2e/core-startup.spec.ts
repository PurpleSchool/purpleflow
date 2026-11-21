import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { PurpleFlowBridge } from '../src/shared/ipc';
import { launch, makeSandbox, quit, type Launched } from './harness';

type AppWindow = { purpleflow: PurpleFlowBridge };

test('ошибка запуска ядра возвращается в окно без бесконечного ожидания', async () => {
  const box = makeSandbox();
  let launched: Launched | undefined;
  try {
    fs.writeFileSync(path.join(box.profile, 'data'), 'file instead of directory');
    const l = await launch(box);
    launched = l;
    const failures = await l.page.evaluate(async () => {
      const { core } = (window as unknown as AppWindow).purpleflow;
      const failure = (promise: Promise<unknown>) =>
        promise.then(
          () => 'resolved',
          (error: Error) => error.message,
        );
      const deadline = new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 5000));
      return Promise.all([core.listRuns(), core.listProjects()].map((promise) => Promise.race([failure(promise), deadline])));
    });
    for (const message of failures) {
      expect(message).toContain('Не удалось запустить ядро');
      expect(message).toContain('data');
    }
    await expect
      .poll(() =>
        l.app.evaluate(({ app }) =>
          app.getAppMetrics().some((entry) => entry.serviceName === 'PurpleFlow Core' || entry.name === 'PurpleFlow Core'),
        ),
      )
      .toBe(false);
    const retry = await l.page.evaluate(() =>
      (window as unknown as AppWindow).purpleflow.core.listRuns().then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
    );
    expect(retry).toContain('Не удалось запустить ядро');
    expect(l.errors).toEqual([]);
  } finally {
    try {
      if (launched) await quit(launched);
    } finally {
      box.cleanup();
    }
  }
});
