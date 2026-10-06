import fs from 'node:fs';
import path from 'node:path';
import { exec, run } from './proc.js';
import type { DiffFile } from './types.js';

/** Очередь операций по worktree: дифф для окна и коммит стадии не должны одновременно брать index.lock. */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = path.resolve(key);
  const prev = queues.get(k) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(k, next.finally(() => {
    if (queues.get(k) === next) queues.delete(k);
  }));
  return next;
}

export class Git {
  constructor(private bin: string, private env: NodeJS.ProcessEnv) {}

  /** git с повтором, если index.lock держит посторонний процесс (IDE, другой git). */
  private async git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    for (let i = 0; ; i++) {
      try {
        return await exec(this.bin, args, cwd, this.env, timeoutMs);
      } catch (e) {
        if (i >= 5 || !String((e as Error).message).includes('index.lock')) throw e;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }

  async isRepo(dir: string): Promise<boolean> {
    const r = await run(this.bin, ['rev-parse', '--is-inside-work-tree'], { cwd: dir, env: this.env, timeoutMs: 10_000 });
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  async topLevel(dir: string): Promise<string> {
    return (await this.git(dir, ['rev-parse', '--show-toplevel'])).trim();
  }

  async head(dir: string): Promise<string> {
    return (await this.git(dir, ['rev-parse', 'HEAD'])).trim();
  }

  /**
   * Новая worktree на ветке psflow/<id> от HEAD пользователя.
   * Рабочая копия пользователя не меняется: ни checkout, ни stash.
   */
  async addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await this.git(repo, ['worktree', 'add', '-b', branch, worktreePath, base], 120_000);
  }

  async worktreeExists(repo: string, worktreePath: string): Promise<boolean> {
    if (!fs.existsSync(worktreePath)) return false;
    const out = await this.git(repo, ['worktree', 'list', '--porcelain']).catch(() => '');
    const norm = (p: string) => path.resolve(p).toLowerCase();
    return out.split('\n').some((l) => l.startsWith('worktree ') && norm(l.slice(9)) === norm(worktreePath));
  }

  /** Дифф ветки против базового коммита, включая новые неотслеживаемые файлы. */
  diff(worktree: string, base: string, skip: (path: string) => boolean = () => false): Promise<DiffFile[]> {
    return serialized(worktree, () => this.diffUnsafe(worktree, base, skip));
  }

  private async diffUnsafe(worktree: string, base: string, skip: (path: string) => boolean): Promise<DiffFile[]> {
    // intent-to-add делает новые файлы видимыми для git diff, не меняя их содержимого.
    await this.git(worktree, ['add', '-A', '-N']);
    const out = await this.git(worktree, ['diff', '--name-status', '-M', '-z', base]);
    const parts = out.split('\0').filter(Boolean);
    const files: DiffFile[] = [];
    for (let i = 0; i < parts.length; ) {
      const code = parts[i++];
      const st = code[0] as DiffFile['status'];
      let oldPath: string;
      let newPath: string;
      if (st === 'R') {
        oldPath = parts[i++];
        newPath = parts[i++];
      } else {
        oldPath = newPath = parts[i++];
      }
      if (skip(newPath)) continue;
      const original = st === 'A' ? '' : await this.show(worktree, base, oldPath);
      const full = path.join(worktree, newPath);
      const modified = st === 'D' ? '' : fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      const binary = original.includes('\0') || modified.includes('\0');
      files.push({
        path: newPath,
        status: st === 'A' || st === 'M' || st === 'D' || st === 'R' ? st : 'M',
        original: binary ? '' : original,
        modified: binary ? '' : modified,
        binary,
      });
    }
    return files;
  }

  /** Унифицированный дифф текстом — для промпта ревьюера. */
  diffText(worktree: string, base: string, excludeGlobs: string[] = []): Promise<string> {
    return serialized(worktree, async () => {
      await this.git(worktree, ['add', '-A', '-N']);
      const args = ['diff', '-M', base, '--', '.', ...excludeGlobs.map((p) => `:(exclude,glob)${p}`)];
      return this.git(worktree, args, 60_000);
    });
  }

  async show(cwd: string, rev: string, file: string): Promise<string> {
    const r = await run(this.bin, ['show', `${rev}:${file}`], { cwd, env: this.env, timeoutMs: 20_000 });
    return r.code === 0 ? r.stdout : '';
  }

  commitAll(worktree: string, message: string): Promise<string> {
    return serialized(worktree, () => this.commitUnsafe(worktree, message));
  }

  private async commitUnsafe(worktree: string, message: string): Promise<string> {
    await this.git(worktree, ['add', '-A']);
    const status = await this.git(worktree, ['status', '--porcelain']);
    if (!status.trim()) return this.head(worktree);
    // Своё имя автора только если в репозитории не настроено — глобальный конфиг не трогаем.
    const hasUser = (await run(this.bin, ['config', 'user.email'], { cwd: worktree, env: this.env })).stdout.trim();
    const identity = hasUser ? [] : ['-c', 'user.name=PS Flow', '-c', 'user.email=psflow@localhost'];
    await this.git(worktree, [...identity, 'commit', '-m', message, '--no-verify']);
    return this.head(worktree);
  }
}
