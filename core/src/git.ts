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

  /** Текущая ветка рабочей копии (null — detached HEAD). */
  async currentBranch(dir: string): Promise<string | null> {
    const r = await run(this.bin, ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, env: this.env });
    return r.stdout.trim() || null;
  }

  /** Незакоммиченные изменения рабочей копии, включая неотслеживаемые файлы. */
  async dirtyFiles(dir: string): Promise<string[]> {
    const out = await this.git(dir, ['status', '--porcelain']);
    return out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  }

  /** Режим «ветка»: новая ветка от base прямо в рабочей копии пользователя. */
  async checkoutNewBranch(repo: string, branch: string, base: string): Promise<void> {
    await this.git(repo, ['checkout', '-b', branch, base], 60_000);
  }

  /** Дифф между двумя коммитами — для завершённого прогона, когда рабочая копия уже на другой ветке. */
  async diffCommits(repo: string, base: string, head: string, skip: (path: string) => boolean = () => false): Promise<DiffFile[]> {
    const out = await this.git(repo, ['diff', '--name-status', '-M', '-z', base, head]);
    const parts = out.split('\0').filter(Boolean);
    const files: DiffFile[] = [];
    for (let i = 0; i < parts.length; ) {
      const code = parts[i++];
      const st = code[0] as DiffFile['status'];
      const oldPath = parts[i++];
      const newPath = st === 'R' ? parts[i++] : oldPath;
      if (skip(newPath)) continue;
      const original = st === 'A' ? '' : await this.show(repo, base, oldPath);
      const modified = st === 'D' ? '' : await this.show(repo, head, newPath);
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

  /** Файлы каталога в коммите (пути от корня репозитория). */
  async listAt(repo: string, rev: string, dir: string): Promise<string[]> {
    const r = await run(this.bin, ['ls-tree', '-r', '--name-only', rev, '--', dir], { cwd: repo, env: this.env, timeoutMs: 20_000 });
    return r.code === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : [];
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

  /** Пути изменённых файлов ветки против базового коммита (с новыми неотслеживаемыми). */
  changedFiles(worktree: string, base: string): Promise<string[]> {
    return serialized(worktree, async () => {
      await this.git(worktree, ['add', '-A', '-N']);
      const out = await this.git(worktree, ['diff', '--name-only', base]);
      return out.split('\n').map((x) => x.trim()).filter(Boolean);
    });
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

  commitAll(worktree: string, message: string, exclude: string[] = []): Promise<string> {
    return serialized(worktree, () => this.commitUnsafe(worktree, message, exclude));
  }

  private async commitUnsafe(worktree: string, message: string, exclude: string[]): Promise<string> {
    await this.git(worktree, ['add', '-A', '--', '.', ...exclude.map((e) => `:(exclude)${e}`)]);
    if (exclude.length) await run(this.bin, ['reset', '-q', '--', ...exclude], { cwd: worktree, env: this.env });
    const status = await this.git(worktree, ['status', '--porcelain']);
    if (!status.trim()) return this.head(worktree);
    // Своё имя автора только если в репозитории не настроено — глобальный конфиг не трогаем.
    const hasUser = (await run(this.bin, ['config', 'user.email'], { cwd: worktree, env: this.env })).stdout.trim();
    const identity = hasUser ? [] : ['-c', 'user.name=PurpleFlow', '-c', 'user.email=psflow@localhost'];
    await this.git(worktree, [...identity, 'commit', '-m', message, '--no-verify']);
    return this.head(worktree);
  }

  /** Локальные ветки репозитория и та, что открыта в основной рабочей копии. */
  async branches(repo: string): Promise<{ branches: string[]; current: string | null }> {
    const out = await this.git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    const cur = (await run(this.bin, ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: repo, env: this.env })).stdout.trim();
    return { branches: out.split('\n').map((x) => x.trim()).filter(Boolean), current: cur || null };
  }

  /** Где сейчас открыта ветка (основная копия или другая worktree), если открыта. */
  private async checkedOutAt(repo: string, branch: string): Promise<string | null> {
    const out = await this.git(repo, ['worktree', 'list', '--porcelain']);
    let wt: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) wt = line.slice(9);
      else if (line === `branch refs/heads/${branch}` && wt) return wt;
    }
    return null;
  }

  /**
   * Влить source в target с merge-коммитом.
   * Если target открыта в рабочей копии — только при чистом дереве; иначе — во временной worktree,
   * не трогая файлы пользователя. При конфликте слияние отменяется и ничего не меняется.
   */
  async merge(repo: string, source: string, target: string, message: string, tmpDir: string): Promise<string> {
    const at = await this.checkedOutAt(repo, target);
    let dir = at;
    let temp = false;
    if (at) {
      const dirty = (await this.git(at, ['status', '--porcelain', '--untracked-files=no'])).trim();
      if (dirty) {
        throw new Error(`В ${at} есть незакоммиченные изменения в ветке ${target}. Закоммитьте или спрячьте их (git stash) и повторите.`);
      }
    } else {
      dir = path.join(tmpDir, `merge-${Date.now()}`);
      await this.git(repo, ['worktree', 'add', dir, target], 60_000);
      temp = true;
    }
    try {
      const hasUser = (await run(this.bin, ['config', 'user.email'], { cwd: dir!, env: this.env })).stdout.trim();
      const identity = hasUser ? [] : ['-c', 'user.name=PurpleFlow', '-c', 'user.email=psflow@localhost'];
      const r = await run(this.bin, [...identity, 'merge', '--no-ff', '-m', message, source], { cwd: dir!, env: this.env, timeoutMs: 120_000 });
      if (r.code !== 0) {
        const conflicts = (await run(this.bin, ['diff', '--name-only', '--diff-filter=U'], { cwd: dir!, env: this.env })).stdout.trim();
        await run(this.bin, ['merge', '--abort'], { cwd: dir!, env: this.env });
        throw new Error(conflicts
          ? `Конфликт при слиянии в ${target}, слияние отменено. Файлы:\n${conflicts}`
          : `Слияние в ${target} не удалось: ${(r.stderr || r.stdout).trim().slice(-600)}`);
      }
      return (await this.git(dir!, ['rev-parse', 'HEAD'])).trim();
    } finally {
      if (temp) await run(this.bin, ['worktree', 'remove', '--force', dir!], { cwd: repo, env: this.env, timeoutMs: 60_000 });
    }
  }
}
