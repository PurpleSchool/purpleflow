import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Ядро собирается прямо из исходников core/src и попадает в бандл main/coreHost —
// в упакованном приложении нет node_modules.
const coreAlias = { '@purpleflow/core': resolve(__dirname, '../core/src/index.ts') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@purpleflow/core'] })],
    resolve: { alias: coreAlias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          coreHost: resolve(__dirname, 'src/main/core-host.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src'), '@purpleflow/route': resolve(__dirname, '../core/src/route.ts') } },
    plugins: [react()],
    worker: { format: 'es' },
  },
});
