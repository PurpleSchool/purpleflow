import fs from 'node:fs';
import path from 'node:path';
import type { ManagerMessage, ProjectConfig, RunFile, RunSummary } from './types.js';

interface IndexEntry {
  id: string;
  runJsonPath: string;
  createdAt: string;
}

function writeAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Источник правды — openspec/changes/<id>/run.json внутри worktree.
 * В каталоге данных приложения храним только индекс путей (для истории) и логи агентов.
 */
export class RunStore {
  private indexFile: string;
  private logsDir: string;

  constructor(private dataDir: string) {
    this.indexFile = path.join(dataDir, 'runs.json');
    this.logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  worktreesDir(): string {
    return path.join(this.dataDir, 'worktrees');
  }

  private readIndex(): IndexEntry[] {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as IndexEntry[];
    } catch {
      return [];
    }
  }

  private writeIndex(list: IndexEntry[]) {
    writeAtomic(this.indexFile, JSON.stringify(list, null, 2));
  }

  static runJsonPath(run: RunFile): string {
    return run.archivedPath ?? path.join(run.worktreePath, 'openspec', 'changes', run.changeId, 'run.json');
  }

  /** Копия run.json в данных приложения: в режиме «ветка» основной файл пропадает, когда пользователь переключает ветку. */
  private backupPath(id: string): string {
    return path.join(this.dataDir, 'runs', `${id}.json`);
  }

  /**
   * В режиме «ветка» run.json в проекте живёт только до коммита прогона (и вовсе не пишется в быстрой правке):
   * иначе рабочая копия пользователя остаётся грязной. Дальше — только копия в данных приложения.
   */
  static inProject(run: RunFile): boolean {
    if (run.worktreeRemoved || run.workspacePending) return false;
    return !(run.workspace === 'branch' && (run.mode === 'quick' || run.commit));
  }

  save(run: RunFile): void {
    run.updatedAt = new Date().toISOString();
    const json = JSON.stringify(run, null, 2) + '\n';
    fs.mkdirSync(path.join(this.dataDir, 'runs'), { recursive: true });
    writeAtomic(this.backupPath(run.id), json);
    const file = RunStore.inProject(run) ? RunStore.runJsonPath(run) : this.backupPath(run.id);
    if (file !== this.backupPath(run.id)) writeAtomic(file, json);
    const index = this.readIndex();
    const entry = index.find((e) => e.id === run.id);
    if (entry) entry.runJsonPath = file;
    else index.unshift({ id: run.id, runJsonPath: file, createdAt: run.createdAt });
    this.writeIndex(index);
  }

  load(id: string): RunFile | null {
    const entry = this.readIndex().find((e) => e.id === id);
    if (!entry) return null;
    return this.readFile(entry.runJsonPath) ?? this.readFile(this.backupPath(id));
  }

  private readFile(file: string): RunFile | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as RunFile;
    } catch {
      return null;
    }
  }

  list(): RunSummary[] {
    return this.readIndex().map((e) => {
      const r = this.readFile(e.runJsonPath) ?? this.readFile(this.backupPath(e.id));
      if (!r) {
        return {
          id: e.id, title: 'run.json не найден', changeId: '', projectPath: '', branch: '', status: 'stopped',
          next: 'plan', createdAt: e.createdAt, updatedAt: e.createdAt, runJsonPath: e.runJsonPath,
          implAttemptsUsed: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, missing: true,
        } satisfies RunSummary;
      }
      return {
        id: r.id, title: r.title, changeId: r.changeId, projectPath: r.projectPath, branch: r.branch,
        status: r.status, next: r.next, createdAt: r.createdAt, updatedAt: r.updatedAt,
        runJsonPath: e.runJsonPath, implAttemptsUsed: r.implAttemptsUsed, totals: r.totals, mode: r.mode,
      };
    });
  }

  remove(id: string): void {
    this.writeIndex(this.readIndex().filter((e) => e.id !== id));
  }

  /** Всё, что прогон хранит в данных приложения: индекс, копия run.json, лог, PID-файлы. */
  forget(id: string): void {
    this.remove(id);
    for (const f of [this.backupPath(id), this.logFile(id), this.chatFile(id), this.pidFile(id), this.pidFile(`${id}:server`), this.pidFile(`${id}:preview`)]) fs.rmSync(f, { force: true });
  }

  private pidFile(group: string): string {
    return path.join(this.dataDir, 'pids', `${group}.json`);
  }

  readPids(group: string): number[] {
    try {
      return JSON.parse(fs.readFileSync(this.pidFile(group), 'utf8')) as number[];
    } catch {
      return [];
    }
  }

  writePids(group: string, pids: number[]): void {
    if (pids.length) writeAtomic(this.pidFile(group), JSON.stringify(pids));
    else fs.rmSync(this.pidFile(group), { force: true });
  }

  private projectsFile(): string {
    return path.join(this.dataDir, 'projects.json');
  }

  /** Настройки проектов по абсолютному пути корня репозитория. */
  readProjects(): Record<string, ProjectConfig> {
    try {
      return JSON.parse(fs.readFileSync(this.projectsFile(), 'utf8')) as Record<string, ProjectConfig>;
    } catch {
      return {};
    }
  }

  writeProject(repo: string, cfg: ProjectConfig): void {
    const all = this.readProjects();
    all[repo] = cfg;
    writeAtomic(this.projectsFile(), JSON.stringify(all, null, 2));
  }

  removeProject(repo: string): void {
    const all = this.readProjects();
    delete all[repo];
    writeAtomic(this.projectsFile(), JSON.stringify(all, null, 2));
  }

  /** Чат менеджера прогона — отдельно от run.json: тот целиком уходит в окно при каждом изменении. */
  chatFile(id: string): string {
    return path.join(this.dataDir, 'manager', `${id}.json`);
  }

  readChat(id: string): ManagerMessage[] {
    try {
      return JSON.parse(fs.readFileSync(this.chatFile(id), 'utf8')) as ManagerMessage[];
    } catch {
      return [];
    }
  }

  writeChat(id: string, messages: ManagerMessage[]): void {
    writeAtomic(this.chatFile(id), JSON.stringify(messages, null, 2));
  }

  logFile(id: string): string {
    return path.join(this.logsDir, `${id}.log`);
  }

  appendLog(id: string, text: string): void {
    fs.appendFileSync(this.logFile(id), text);
  }

  readLog(id: string, maxBytes = 2 * 1024 * 1024): string {
    try {
      const file = this.logFile(id);
      const size = fs.statSync(file).size;
      if (size <= maxBytes) return fs.readFileSync(file, 'utf8');
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch {
      return '';
    }
  }
}
