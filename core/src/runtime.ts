// Общее для ядра и стадий: параметры запуска, лимиты, сигнал остановки.

import type { runClaude } from './agents/claude.js';
import type { runCodex } from './agents/codex.js';
import type { CoreEvent, CoreSettings } from './types.js';

export interface CoreOptions {
  dataDir: string;
  promptsDir: string;
  /** Окружение login-шелла пользователя (см. loadLoginShellEnv). */
  env: NodeJS.ProcessEnv;
  getSettings: () => CoreSettings;
  /** Подмена агентов — для тестов конвейера без настоящих claude и codex. */
  runners?: { claude?: typeof runClaude; codex?: typeof runCodex };
}

export type Listener = (e: CoreEvent) => void;

export interface Tools {
  git: string;
  claude: string;
  codex: string;
  openspec: string;
}

export class StopSignal extends Error {}

export const IMPL_LIMIT = 3;

export const PLAN_RETRIES = 2;

export const MAX_TEST_OUTPUT = 12_000;

/** Дифф до такого размера кладётся в промпт ревьюера целиком, больше — списком файлов, ревьюер читает сам. */
export const INLINE_DIFF = 60_000;

export const RUN_JSON_GLOB = 'openspec/changes/**/run.json';

export const CHECK_NAME = { lint: 'линтер', test: 'тесты' } as const;
