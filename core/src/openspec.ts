import fs from 'node:fs';
import path from 'node:path';
import { prependPath } from './env.js';
import { run } from './proc.js';

export interface ValidationIssue {
  level: string;
  path?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  raw: string;
}

export class OpenSpec {
  private env: NodeJS.ProcessEnv;
  constructor(private bin: string, env: NodeJS.ProcessEnv) {
    this.env = prependPath({ ...env, NO_COLOR: '1', OPENSPEC_TELEMETRY: '0' }, path.dirname(bin));
  }

  hasOpenSpec(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'openspec'));
  }

  /** В репозитории без OpenSpec инициализируем его прямо в worktree (без файлов для AI-инструментов). */
  async ensureInit(dir: string, group: string): Promise<void> {
    if (this.hasOpenSpec(dir)) return;
    const r = await run(this.bin, ['init', '--tools', 'none', '--no-animation', '.'], { cwd: dir, env: this.env, timeoutMs: 60_000, group });
    if (r.code !== 0 || !this.hasOpenSpec(dir)) {
      throw new Error(`openspec init не удался: ${(r.stderr || r.stdout).trim().slice(-800)}`);
    }
  }

  changeDir(dir: string, id: string): string {
    return path.join(dir, 'openspec', 'changes', id);
  }

  async validate(dir: string, id: string, group: string): Promise<ValidationResult> {
    if (!fs.existsSync(this.changeDir(dir, id))) {
      return { valid: false, issues: [{ level: 'ERROR', message: `Папка openspec/changes/${id} не создана` }], raw: '' };
    }
    const r = await run(this.bin, ['validate', id, '--type', 'change', '--strict', '--json', '--no-interactive'], {
      cwd: dir, env: this.env, timeoutMs: 60_000, group,
    });
    const raw = (r.stdout || r.stderr).trim();
    try {
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      const item = (json.items ?? []).find((i: { id: string }) => i.id === id) ?? json.items?.[0];
      const issues: ValidationIssue[] = (item?.issues ?? []).map((i: Record<string, unknown>) => ({
        level: String(i.level ?? 'ERROR'),
        path: i.path ? String(i.path) : undefined,
        message: String(i.message ?? JSON.stringify(i)),
      }));
      return { valid: Boolean(item?.valid) && r.code === 0, issues, raw };
    } catch {
      return { valid: false, issues: [{ level: 'ERROR', message: raw.slice(-2000) || `код ${r.code}` }], raw };
    }
  }

  /** `openspec archive <id> -y`; возвращает новую папку изменения внутри archive/. */
  async archive(dir: string, id: string, group: string): Promise<string> {
    const r = await run(this.bin, ['archive', id, '-y', '--json'], { cwd: dir, env: this.env, timeoutMs: 120_000, group });
    if (r.code !== 0) throw new Error(`openspec archive: ${(r.stderr || r.stdout).trim().slice(-1500)}`);
    try {
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      if (json.archive?.path) return json.archive.path as string;
    } catch { /* старый формат вывода — ищем папку сами */ }
    const archiveRoot = path.join(dir, 'openspec', 'changes', 'archive');
    const found = fs.readdirSync(archiveRoot).filter((n) => n.endsWith(`-${id}`)).sort().pop();
    if (!found) throw new Error('openspec archive завершился, но папка архива не найдена');
    return path.join(archiveRoot, found);
  }

  async version(): Promise<string> {
    const r = await run(this.bin, ['--version'], { cwd: process.cwd(), env: this.env, timeoutMs: 15_000 });
    return r.stdout.trim();
  }
}
