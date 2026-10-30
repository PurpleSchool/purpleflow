// Место на диске: что занимают данные PurpleFlow и что можно почистить.
import fs from 'node:fs';
import path from 'node:path';
import { Git } from '../git.js';
import type { Kernel } from '../kernel.js';
import { browserLeftovers, screenshots, sizeOfAll, subdirs } from '../storage.js';
import type { RunFile, StorageItem } from '../types.js';
import { stopPreview } from './preview.js';
import { runsWithFiles } from './runs.js';

export async function getStorage(k: Kernel): Promise<StorageItem[]> {
  const runs = runsWithFiles(k);
  const wtRoot = k.store.worktreesDir();
  const own = (r: RunFile) =>
    r.workspace !== 'branch' && !r.worktreeRemoved && fs.existsSync(r.worktreePath) && r.worktreePath.startsWith(wtRoot);
  const ended = (r: RunFile) => r.status === 'finished' || r.status === 'cancelled';
  const done = runs.filter((r) => own(r) && ended(r));
  const active = runs.filter((r) => own(r) && !ended(r));
  const known = new Set(runs.map((r) => path.resolve(r.worktreePath)));
  const orphan = subdirs(wtRoot).filter((d) => !known.has(path.resolve(d)) && !path.basename(d).startsWith('merge-'));
  const visualRoot = path.join(k.opts.dataDir, 'visual');
  const leftovers = browserLeftovers(visualRoot);
  const shots = screenshots(visualRoot);
  const history = ['logs', 'runs', 'attachments'].map((d) => path.join(k.opts.dataDir, d));
  return [
    {
      id: 'worktrees-done',
      title: 'Рабочие копии завершённых прогонов',
      hint: 'Worktree с зависимостями. Ветки с результатом, история, дифф и план остаются — пропадёт только ручной запуск во вкладке «Браузер».',
      bytes: await sizeOfAll(done.map((r) => r.worktreePath)),
      count: done.length,
      clean: 'Удалить',
    },
    {
      id: 'worktrees-active',
      title: 'Рабочие копии незавершённых прогонов',
      hint: 'Нужны, чтобы продолжить прогон. Удаляются вместе с прогоном.',
      bytes: await sizeOfAll(active.map((r) => r.worktreePath)),
      count: active.length,
    },
    {
      id: 'worktrees-orphan',
      title: 'Брошенные рабочие копии',
      hint: 'Остались от удалённых или потерянных прогонов — ни к чему не привязаны.',
      bytes: await sizeOfAll(orphan),
      count: orphan.length,
      clean: 'Удалить',
    },
    {
      id: 'browser',
      title: 'Служебные файлы браузера',
      hint: 'Профили Chrome и кэш Playwright после визуальных проверок. Скриншоты не трогаются.',
      bytes: await sizeOfAll(leftovers),
      count: leftovers.length,
      clean: 'Удалить',
    },
    {
      id: 'shots',
      title: 'Скриншоты визуальных проверок',
      hint: 'Пропадут из деталей стадии «Визуальная проверка» у всех прогонов.',
      bytes: await sizeOfAll(shots),
      count: shots.length,
      clean: 'Удалить',
    },
    {
      id: 'history',
      title: 'История прогонов',
      hint: 'Логи, run.json и изображения к задачам. Удаляются вместе с прогоном.',
      bytes: await sizeOfAll(history),
      count: runs.length,
    },
  ];
}

/** Очистить категорию; возвращает, сколько байт освободили. */
export async function cleanStorage(k: Kernel, id: StorageItem['id']): Promise<number> {
  const before = (await getStorage(k)).find((x) => x.id === id)?.bytes ?? 0;
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  const wtRoot = k.store.worktreesDir();
  if (id === 'worktrees-done') {
    for (const r of runsWithFiles(k)) {
      if (r.workspace === 'branch' || r.worktreeRemoved || !(r.status === 'finished' || r.status === 'cancelled')) continue;
      if (!r.worktreePath.startsWith(wtRoot) || k.driving.has(r.id)) continue;
      await stopPreview(k, r.id);
      // Сначала помечаем: дальше run.json пишется только в данные приложения и worktree не пересоздаётся.
      r.worktreeRemoved = true;
      k.save(r);
      await git.removeWorktree(r.projectPath, r.worktreePath).catch(() => fs.rmSync(r.worktreePath, { recursive: true, force: true }));
    }
  } else if (id === 'worktrees-orphan') {
    const known = new Set(runsWithFiles(k).map((r) => path.resolve(r.worktreePath)));
    for (const d of subdirs(wtRoot)) {
      if (known.has(path.resolve(d)) || path.basename(d).startsWith('merge-')) continue;
      // Worktree знает свой репозиторий по файлу .git — снимаем регистрацию там же.
      let gitdir: string | null = null;
      try {
        gitdir =
          fs
            .readFileSync(path.join(d, '.git'), 'utf8')
            .match(/gitdir:\s*(.+)/)?.[1]
            ?.trim() ?? null;
      } catch {
        /* не worktree */
      }
      const repo = gitdir ? path.resolve(gitdir, '..', '..', '..') : null;
      if (repo && fs.existsSync(repo)) await git.removeWorktree(repo, d).catch(() => undefined);
      fs.rmSync(d, { recursive: true, force: true });
    }
  } else if (id === 'browser') {
    for (const p of browserLeftovers(path.join(k.opts.dataDir, 'visual'))) fs.rmSync(p, { recursive: true, force: true });
  } else if (id === 'shots') {
    for (const p of screenshots(path.join(k.opts.dataDir, 'visual'))) fs.rmSync(p, { force: true });
  }
  const after = (await getStorage(k)).find((x) => x.id === id)?.bytes ?? 0;
  return Math.max(0, before - after);
}
