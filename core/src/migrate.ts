// Миграции run.json: старые прогоны приводятся к текущей схеме при чтении, чтобы код ниже не гадал о пропущенных полях.
import { DEFAULT_AGENTS } from './model/settings.js';
import type { RunFile } from './types.js';

export const RUN_VERSION = 2;

/** Файл прогона любой прежней версии. */
type StoredRun = Omit<RunFile, 'version' | 'mode' | 'workspace' | 'agents'> &
  Partial<Pick<RunFile, 'mode' | 'workspace' | 'agents'>> & { version: number };

/** v1 → v2: режим, место работы и агенты по ролям стали обязательными; у старых прогонов — значения тех времён. */
export function migrateRun(raw: StoredRun): RunFile {
  if (raw.version > RUN_VERSION) throw new Error(`run.json версии ${raw.version} создан более новой версией PurpleFlow`);
  return {
    ...raw,
    version: RUN_VERSION,
    mode: raw.mode ?? 'task',
    workspace: raw.workspace ?? 'worktree',
    agents: { ...DEFAULT_AGENTS, ...raw.agents },
  };
}
