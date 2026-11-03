import { defineConfig } from '@playwright/test';

// Каждый тест запускает своё окно со своим профилем, но все они пишут в общий каталог сборки и нагружают машину CI:
// параллельность здесь экономит мало, а таймауты делает случайными.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
