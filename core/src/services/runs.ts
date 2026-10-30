// Данные прогона для окна: дифф, изменённые файлы, документы изменения OpenSpec.
import fs from 'node:fs';
import path from 'node:path';
import { Git } from '../git.js';
import type { Kernel } from '../kernel.js';
import type { DiffFile, RunFile } from '../types.js';
import { diffBase, envFilesOf } from './workspace.js';

export function runsWithFiles(k: Kernel): RunFile[] {
  return k.store
    .list()
    .map((s) => k.store.load(s.id))
    .filter((r): r is RunFile => Boolean(r));
}

export async function getDiff(k: Kernel, id: string): Promise<DiffFile[]> {
  const r = k.mustLoad(id);
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  const skip = diffSkip(k, r);
  // Завершённый прогон — дифф ветки прогона: рабочая копия могла уйти на другую ветку.
  if (r.status === 'finished') return git.diffCommits(r.projectPath, r.baseCommit, r.branch, skip);
  return git.diff(r.worktreePath, diffBase(k, r), skip);
}

/** Какие файлы не показывать в диффе: run.json, файлы окружения; в круге конфликтов — всё, кроме разрешённых. */
export function diffSkip(k: Kernel, r: RunFile): (p: string) => boolean {
  const env = new Set(envFilesOf(k, r));
  const only = r.status !== 'finished' && r.roundFiles?.length ? new Set(r.roundFiles) : null;
  return (p: string) => (p.startsWith('openspec/') && p.endsWith('/run.json')) || env.has(p) || Boolean(only && !only.has(p));
}

/** Изменённые файлы без содержимого — для счётчика на вкладке «Код». */
export async function getChangedFiles(k: Kernel, id: string): Promise<string[]> {
  const r = k.mustLoad(id);
  if (r.workspacePending || (r.worktreeRemoved && r.status !== 'finished')) return [];
  const git = new Git((await k.tools(['git'])).git, k.opts.env);
  const skip = diffSkip(k, r);
  const files =
    r.status === 'finished'
      ? await git.namesBetween(r.projectPath, r.baseCommit, r.branch)
      : await git.changedFiles(r.worktreePath, diffBase(k, r));
  return files.filter((f) => !skip(f));
}

/** proposal.md, tasks.md и дельты спецификаций — для гейта 1 и ревью. */
export async function getChangeDocs(
  k: Kernel,
  id: string,
): Promise<{ proposal: string; tasks: string; design: string; specs: { path: string; content: string }[] }> {
  const r = k.mustLoad(id);
  const dir = r.archivedPath ? path.dirname(r.archivedPath) : path.join(r.worktreePath, 'openspec', 'changes', r.changeId);
  if (!fs.existsSync(dir) && r.status === 'finished') {
    // Режим «ветка» после переключения ветки: читаем документы из ветки прогона.
    const tools = await k.tools(['git']);
    const git = new Git(tools.git, k.opts.env);
    const rel = path.relative(r.worktreePath, dir).split(path.sep).join('/');
    const at = (f: string) => git.show(r.projectPath, r.branch, `${rel}/${f}`);
    const specFiles = (await git.listAt(r.projectPath, r.branch, `${rel}/specs`)).filter((f) => f.endsWith('.md')).sort();
    return {
      proposal: await at('proposal.md'),
      tasks: await at('tasks.md'),
      design: await at('design.md'),
      specs: await Promise.all(
        specFiles.map(async (f) => ({ path: f.slice(rel.length + 1), content: await git.show(r.projectPath, r.branch, f) })),
      ),
    };
  }
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  const specs: { path: string; content: string }[] = [];
  const specsDir = path.join(dir, 'specs');
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md'))
        specs.push({ path: path.relative(dir, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(specsDir);
  return { proposal: read('proposal.md'), tasks: read('tasks.md'), design: read('design.md'), specs };
}
