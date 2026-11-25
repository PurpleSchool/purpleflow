import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as Registry from '../../../src/main/connect/services/registry.js';
import type * as Runtime from '../../../src/main/connect/core/runtime.js';
import type { SetupContext } from '../../../src/main/connect/core/types.js';

// Исходники установщика — CommonJS. На Node 22 import из .mts и require внутри них дают два экземпляра
// runtime.ts: флаг dry-run, выставленный здесь, модули записи не видели и меняли файлы. Грузим всё через require.
const require = createRequire(import.meta.url);
const { services } = require('../../../src/main/connect/services/registry.js') as typeof Registry;
const { setDryRun } = require('../../../src/main/connect/core/runtime.js') as typeof Runtime;

const [family, id, operation] = process.argv.slice(2);
const service = services.find((item) => (item.authScheme ?? 'anthropic') === family)!;
const target = service.targets.find((item) => item.id === id)!;
if (!target) throw new Error(`Unknown target ${id}`);
const ctx: SetupContext = {
  apiKey: 'test-only-key-not-a-real-secret',
  baseUrl: process.env.TEST_BASE_URL ?? `https://example.invalid/${family}`,
  platform: 'linux',
  dryRun: operation === 'dry-run',
  model: family === 'anthropic' ? 'claude-test-selected' : 'gpt-test-selected',
  proxyModels: family === 'anthropic' ? { 'claude-test-selected': 'Claude Test' } : { 'gpt-test-selected': 'GPT Test' },
};
setDryRun(ctx.dryRun);
try {
  if (operation === 'check' || operation === 'check-dry-run') await target.ensureAvailable?.(operation === 'check-dry-run');
  else if (operation === 'is-configured') console.log(await target.isConfigured?.());
  else if (operation === 'remove' || operation === 'remove-prepared') await target.remove?.(ctx);
  else {
    // Tests intentionally call configuration only, without external applications or credentials.
    if (id.includes('neovim')) fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME!, 'nvim'), { recursive: true });
    await target.apply(ctx);
  }
  console.log('OK');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
