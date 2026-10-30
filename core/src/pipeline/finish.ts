import fs from 'node:fs';
import path from 'node:path';
import { c } from '../agents/common.js';
import { pushBranch } from '../github.js';
import { Git } from '../git.js';
import { OpenSpec } from '../openspec.js';
import { RunStore } from '../store.js';
import { modeOf } from '../modes.js';
import type { RunFile } from '../types.js';
import type { Orchestrator } from '../orchestrator.js';
export async function stageFinish(h: Orchestrator, run: RunFile) {
  const tools = await h.tools(['git', 'openspec']);
  const attempt = h.begin(run, 'finish');
  const openspec = new OpenSpec(tools.openspec, h.opts.env);
  const git = new Git(tools.git, h.opts.env);

  // Повтор после сбоя на коммите: архив уже сделан — второй раз openspec archive не запускаем.
  if (modeOf(run) !== 'quick' && (!run.archivedPath || !fs.existsSync(path.dirname(run.archivedPath)))) {
    h.log(run, c.sky(`$ openspec archive ${run.changeId} -y`) + '\n');
    const archivedDir = await openspec.archive(run.worktreePath, run.changeId, run.id);
    run.archivedPath = path.join(archivedDir, 'run.json');
    h.log(run, c.dim(`архив: ${path.relative(run.worktreePath, archivedDir)}`) + '\n');
  }

  // Финальное состояние пишем до коммита, чтобы в ветке лежал полный run.json.
  h.end(run, attempt, 'done', `Коммит в ${run.branch}`);
  run.status = 'finished';
  run.finishedAt = new Date().toISOString();
  run.next = 'finish';
  h.save(run);
  let sha: string;
  try {
    // Быстрая правка идёт без OpenSpec: run.json остаётся в данных прогона, но не в коммите проекта.
    const exclude = [
      ...(modeOf(run) === 'quick' && RunStore.inProject(run)
        ? [path.relative(run.worktreePath, RunStore.runJsonPath(run)).split(path.sep).join('/')]
        : []),
      // Скопированные файлы окружения — секреты разработчика, в коммит не попадают даже без .gitignore.
      ...h.envFilesOf(run),
    ];
    const round = run.prRound && run.pr ? run.prRounds?.at(-1) : undefined;
    const message =
      round?.kind === 'update'
        ? `Merge ${run.pr!.base} в ${run.branch}${round.conflicts?.length ? `\n\nРазрешены конфликты:\n${round.conflicts.map((f) => `- ${f}`).join('\n')}` : ''}\n\nPurpleFlow run: ${run.id}`
        : round
          ? `purpleflow: ${run.changeId} — замечания PR #${run.pr!.number}\n\nКруг доработки ${round.round}:\n${round.items.map((i) => `- ${i.kind === 'check' ? `CI: ${i.body}` : `${i.path ? i.path + ': ' : ''}${i.body.split('\n')[0].slice(0, 120)}`}`).join('\n')}${round.note ? `\n- ${round.note.split('\n')[0]}` : ''}\n\nPurpleFlow run: ${run.id}`
          : `purpleflow: ${run.changeId}\n\n${run.task}\n\n${modeOf(run) === 'quick' ? '' : `OpenSpec change: ${run.changeId}\n`}PurpleFlow run: ${run.id}`;
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
  h.save(run);
  // Круг доработки по PR: правки сразу уходят в ветку PR.
  const round = run.prRound && run.pr ? run.prRounds?.at(-1) : undefined;
  if (round && run.roundBase && sha !== run.roundBase) {
    h.log(run, c.sky(`$ git push origin ${run.branch}`) + '\n');
    try {
      await pushBranch(tools.git, run.worktreePath, run.branch, h.opts.env);
      round.commit = sha;
      h.save(run);
      h.log(run, c.mint(`✓ правки отправлены в PR #${run.pr!.number}`) + '\n');
    } catch (e) {
      run.message = `Коммит есть, но push не прошёл: ${(e as Error).message}. Отправьте вручную: git push origin ${run.branch}`;
      h.save(run);
      h.log(run, c.amber(`! ${run.message}`) + '\n');
    }
  }
  h.log(
    run,
    sha === run.baseCommit
      ? c.amber(`! изменений нет — коммит в ${run.branch} не создан`) + '\n'
      : c.mint(`✓ коммит ${sha.slice(0, 8)} в ветке ${run.branch}. Слияние — за вами.`) + '\n',
  );
  if (run.workspace === 'branch') {
    h.log(
      run,
      c.dim(
        `Проект остался на ветке ${run.branch} — можно посмотреть результат.${run.originalBranch ? ` Вернуться: git checkout ${run.originalBranch}` : ''}`,
      ) + '\n',
    );
  }
  h.emit({ type: 'run.updated', run });
  h.emit({ type: 'run.finished', runId: run.id, status: 'finished' });
  // Уроки для следующих прогонов — в фоне, коммит уже сделан.
  void h.learn(run).catch(() => undefined);
}
