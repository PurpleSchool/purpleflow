import { expect, test } from '@playwright/test';
import type { PurpleFlowBridge } from '../src/shared/ipc';
import { launch, makeSandbox, quit, type Launched } from './harness';

type AppWindow = { purpleflow: PurpleFlowBridge };

test('запрос установки без скачанного обновления оставляет ядро работающим', async () => {
  const box = makeSandbox();
  let launched: Launched | undefined;
  try {
    const l = await launch(box);
    launched = l;
    const corePids = () =>
      l.app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .filter((p) => p.serviceName === 'PurpleFlow Core' || p.name === 'PurpleFlow Core')
          .map((p) => p.pid),
      );
    await expect.poll(corePids).toHaveLength(1);
    const [original] = await corePids();
    expect(original).toBeGreaterThan(0);
    const response = await l.page.evaluate(async () => {
      const { update } = (window as unknown as AppWindow).purpleflow;
      const before = await update.state();
      const result = await update.install().then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      return { before, result, after: await update.state() };
    });
    const pids = await corePids();
    expect(response.before).toEqual({ kind: 'idle' });
    expect(response.result).toContain('Обновление ещё не готово к установке');
    expect(response.after).toEqual({ kind: 'idle' });
    expect(pids).toEqual([original]);
    expect(await l.page.evaluate(() => (window as unknown as AppWindow).purpleflow.core.listRuns())).toEqual([]);
    expect(l.errors).toEqual([]);
  } finally {
    try {
      if (launched) await quit(launched);
    } finally {
      box.cleanup();
    }
  }
});
