// Стадия «Завершение»: архив изменения OpenSpec и коммит в ветку прогона.
import fs from 'node:fs';
import path from 'node:path';
import { c } from '../agents/common.js';
import { Git } from '../git.js';
import { pushBranch } from '../github.js';
import type { Kernel } from '../kernel.js';

import { OpenSpec } from '../openspec.js';
import { learn } from '../services/projects.js';
import { envFilesOf } from '../services/workspace.js';
import { RunStore } from '../store.js';
import type { RunFile } from '../types.js';
export async function stageFinish(k: Kernel, run: RunFile) {
  const tools = await k.tools(['git', 'openspec']);
  const attempt = k.begin(run, 'finish');
  const openspec = new OpenSpec(tools.openspec, k.opts.env);
  const git = new Git(tools.git, k.opts.env);

  // Повтор после сбоя на коммите: архив уже сделан — второй раз openspec archive не запускаем.
  if (run.mode !== 'quick' && (!run.archivedPath || !fs.existsSync(path.dirname(run.archivedPath)))) {
    k.log(run, c.sky(`$ openspec archive ${run.changeId} -y`) + '\n');
    const archivedDir = await openspec.archive(run.worktreePath, run.changeId, run.id);
    run.archivedPath = path.join(archivedDir, 'run.json');
    k.log(run, c.dim(`архив: ${path.relative(run.worktreePath, archivedDir)}`) + '\n');
  }

  // Финальное состояние пишем до коммита, чтобы в ветке лежал полный run.json.
  k.end(run, attempt, 'done', `Коммит в ${run.branch}`);
  run.status = 'finished';
  run.finishedAt = new Date().toISOString();
  run.next = 'finish';
  k.save(run);
  let sha: string;
  try {
    // Быстрая правка идёт без OpenSpec: run.json остаётся в данных прогона, но не в коммите проекта.
    const exclude = [
      ...(run.mode === 'quick' && RunStore.inProject(run)
        ? [path.relative(run.worktreePath, RunStore.runJsonPath(run)).split(path.sep).join('/')]
        : []),
      // Скопированные файлы окружения — секреты разработчика, в коммит не попадают даже без .gitignore.
      ...envFilesOf(k, run),
    ];
    const round = run.prRound && run.pr ? run.prRounds?.at(-1) : undefined;
    const message =
      round?.kind === 'update'
        ? `Merge ${run.pr!.base} в ${run.branch}${round.conflicts?.length ? `\n\nРазрешены конфликты:\n${round.conflicts.map((f) => `- ${f}`).join('\n')}` : ''}\n\nPurpleFlow run: ${run.id}`
        : round
          ? `purpleflow: ${run.changeId} — замечания PR #${run.pr!.number}\n\nКруг доработки ${round.round}:\n${round.items.map((i) => `- ${i.kind === 'check' ? `CI: ${i.body}` : `${i.path ? i.path + ': ' : ''}${i.body.split('\n')[0].slice(0, 120)}`}`).join('\n')}${round.note ? `\n- ${round.note.split('\n')[0]}` : ''}\n\nPurpleFlow run: ${run.id}`
          : `purpleflow: ${run.changeId}\n\n${run.task}\n\n${run.mode === 'quick' ? '' : `OpenSpec change: ${run.changeId}\n`}PurpleFlow run: ${run.id}`;
    sha = await git.commitAll(run.worktreePath, message, exclude);
  } catch (e) {
    // Коммит не прошёл — прогон не завершён: возвращаем статус и честно помечаем попытку.
    run.status = 'running';
    run.finishedAt = undefined;
    Object.assign(attempt, { status: 'running', endedAt: undefined, summary: undefined });
    throw e;
  }
  run.commit = sha;
  run.roundFiles = undefined;
  k.save(run);
  // Круг доработки по PR: правки сразу уходят в ветку PR.
  const round = run.prRound && run.pr ? run.prRounds?.at(-1) : undefined;
  if (round && run.roundBase && sha !== run.roundBase) {
    k.log(run, c.sky(`$ git push origin ${run.branch}`) + '\n');
    try {
      await pushBranch(tools.git, run.worktreePath, run.branch, k.opts.env);
      round.commit = sha;
      k.save(run);
      k.log(run, c.mint(`✓ правки отправлены в PR #${run.pr!.number}`) + '\n');
    } catch (e) {
      run.message = `Коммит есть, но push не прошёл: ${(e as Error).message}. Отправьте вручную: git push origin ${run.branch}`;
      k.save(run);
      k.log(run, c.amber(`! ${run.message}`) + '\n');
    }
  }
  k.log(
    run,
    sha === run.baseCommit
      ? c.amber(`! изменений нет — коммит в ${run.branch} не создан`) + '\n'
      : c.mint(`✓ коммит ${sha.slice(0, 8)} в ветке ${run.branch}. Слияние — за вами.`) + '\n',
  );
  if (run.workspace === 'branch') {
    k.log(
      run,
      c.dim(
        `Проект остался на ветке ${run.branch} — можно посмотреть результат.${run.originalBranch ? ` Вернуться: git checkout ${run.originalBranch}` : ''}`,
      ) + '\n',
    );
  }
  k.emit({ type: 'run.updated', run });
  k.emit({ type: 'run.finished', runId: run.id, status: 'finished' });
  // Уроки для следующих прогонов — в фоне, коммит уже сделан.
  void learn(k, run).catch(() => undefined);
}
