// Стадия «Визуальная проверка»: приложение из ветки прогона, браузер и скриншоты для приёмки.
import fs from 'node:fs';
import path from 'node:path';
import { c, crlf } from '../agents/common.js';
import { prependPath } from '../env.js';
import { Git } from '../git.js';
import { formatItem } from '../items.js';
import type { Kernel } from '../kernel.js';
import { expandPorts, freePort, portEnv, waitForUrl } from '../net.js';
import { parseReview, parseShots, parseUnverified } from '../parse.js';
import { killGroup, run as runProc } from '../proc.js';
import { Screencast, findChrome, waitForCdp } from '../screencast.js';
import { agentBase, agentModel, claudeModel } from '../services/agents.js';
import { attachmentsBlock } from '../services/attachments.js';
import { getProjectConfig } from '../services/projects.js';
import { modeRules, taskText } from '../services/prompting.js';
import { getChangeDocs } from '../services/runs.js';
import { diffBase, prepareApp } from '../services/workspace.js';
import type { RunFile, VisualResult } from '../types.js';
export function visualDir(k: Kernel, run: RunFile, attempt: number): string {
  return path.join(k.opts.dataDir, 'visual', run.id, String(attempt));
}

/**
 * Визуальная проверка: поднять приложение в worktree на свободном порту, дать агенту
 * браузер (Playwright CLI через обёртку pw — служебные файлы остаются вне репозитория),
 * собрать скриншоты и вердикт { blocking, notes, shots }.
 */
export async function stageVisual(k: Kernel, run: RunFile) {
  const agent = run.agents.visual ?? 'claude';
  const tools = await k.tools([agent]);
  // Пусто — модель исполнителя (или другой роли), если она на том же агенте.
  const model =
    run.models.visual || (agent === 'claude' ? claudeModel(k, run.agents, run.models) : agentModel(k, 'codex', run.agents, run.models));
  const attempt = k.begin(run, 'visual', model || agent);
  const dir = visualDir(k, run, attempt.attempt);
  fs.mkdirSync(dir, { recursive: true });
  const { port, url, command } = await expandPorts(run.appUrl!, run.runCommand!);
  const serverGroup = `${run.id}:server`;
  let cast: Screencast | null = null;
  /** Хвост вывода команды запуска — показать человеку, если проверить не удалось (упал API и т. п.). */
  let serverOut = '';

  // Миграции и сиды ветки — до запуска: иначе приложение поднимется на старой схеме базы.
  await prepareApp(k, {
    repo: run.projectPath,
    cwd: run.worktreePath,
    group: serverGroup,
    onOutput: (t) => k.log(run, c.dim(crlf(t)), false),
  });
  k.checkStop(run);
  k.log(run, c.sky(`$ ${command}`) + c.dim(`  # приложение на ${url}`) + '\n');
  let exited: number | null | undefined;
  const server = runProc(command, [], {
    cwd: run.worktreePath,
    env: { ...k.opts.env, ...portEnv(run.runCommand!, port), BROWSER: 'none', CI: '1' },
    shell: true,
    group: serverGroup,
    onStdout: (t) => {
      serverOut = (serverOut + t).slice(-6000);
      k.log(run, c.dim(crlf(t)), false);
    },
    onStderr: (t) => {
      serverOut = (serverOut + t).slice(-6000);
      k.log(run, c.dim(crlf(t)), false);
    },
  });
  void server.then((r) => {
    exited = r.code;
  });

  try {
    const ready = await waitForUrl(url, 120_000, () => exited !== undefined || k.stopping.has(run.id));
    k.checkStop(run);
    if (!ready) {
      throw new Error(
        exited !== undefined
          ? `Приложение завершилось с кодом ${exited}, не открыв ${url}. Проверьте команду запуска в командах проекта.`
          : `За 2 минуты приложение не ответило на ${url}. Проверьте команду запуска и адрес ({port} подставляется автоматически).`,
      );
    }
    k.log(run, c.mint(`✓ приложение отвечает на ${url}`) + '\n');

    // pw: обёртка над Playwright CLI с отдельной сессией и рабочей папкой для скриншотов.
    const session = `purpleflow-${run.id.slice(0, 8)}`;
    const isWin = process.platform === 'win32';
    if (isWin) {
      fs.writeFileSync(path.join(dir, 'pw.cmd'), `@echo off\r\ncd /d "${dir}"\r\nnpx -y @playwright/cli@latest -s=${session} %*\r\n`);
    } else {
      fs.writeFileSync(path.join(dir, 'pw'), `#!/bin/sh\ncd "${dir}" && exec npx -y @playwright/cli@latest -s=${session} "$@"\n`, {
        mode: 0o755,
      });
    }

    // Свой Chrome с портом отладки: агент подключается к нему через pw, а окно получает живую трансляцию экрана.
    const live = await startLiveBrowser(k, run, dir, url, serverGroup, session);
    cast = live?.cast ?? null;
    const docs = await getChangeDocs(k, run.id);
    const tg = await k.tools(['git']);
    const changed = await new Git(tg.git, k.opts.env).changedFiles(run.worktreePath, diffBase(k, run));
    const prompt = k.prompts.render('visual.md', {
      url,
      dir,
      task: taskText(k, run),
      attachments: attachmentsBlock(k, run),
      proposal: docs.proposal || '(нет плана — быстрая правка, ориентируйся на задачу)',
      specs: docs.specs.map((x) => x.content).join('\n\n') || '(нет)',
      files:
        changed
          .filter((f) => !f.startsWith('openspec/'))
          .map((f) => `- ${f}`)
          .join('\n') || '(нет)',
      // Свежая инструкция из команд проекта важнее снимка в run.json: её могли дописать после неудачной проверки.
      notes:
        getProjectConfig(k, run.projectPath)?.visualNotes ||
        run.visualNotes ||
        '(нет — если нужен вход или данные, которых нет, верни "unverified")',
    });
    const base = {
      ...agentBase(k, run, tools[agent]),
      env: prependPath(k.opts.env, dir),
      prompt,
      systemPrompt:
        k.prompts.raw('visual.system.md') +
        modeRules(k, 'visual', run) +
        (live
          ? `\n\nБраузер уже открыт на ${url} и подключён к pw — не вызывай \`pw open\`, переходи командой \`pw goto <url>\`. Человек смотрит на этот экран вживую.`
          : ''),
      model: model || undefined,
    };
    const res =
      agent === 'codex'
        ? // pw пишет скриншоты и сессию вне рабочей копии, npx — в свой кэш, браузеру нужна сеть: в песочнице codex это не работает.
          // Код не меняет — это требование промпта, как и у claude.
          await k.codex({ ...base, sandbox: 'danger-full-access' })
        : await k.claude({
            ...base,
            addDirs: [dir, ...(run.attachments?.length ? [path.dirname(run.attachments[0])] : [])],
            // Только смотреть: браузер через Bash (pw), чтение кода — без правки файлов.
            tools: ['Bash', 'Read', 'Glob', 'Grep'],
          });
    k.afterAgent(run, attempt, res);

    const parsed = parseReview(res.text);
    if (!parsed) throw new Error(`Визуальная проверка вернула ответ не в формате JSON:\n${res.text.slice(0, 400)}`);
    const shotsRaw = parseShots(res.text);
    const shots = shotsRaw
      .map((x) => ({ file: path.isAbsolute(x.file) ? x.file : path.join(dir, x.file), caption: x.caption }))
      .filter((x) => x.file.startsWith(dir) && fs.existsSync(x.file));
    // Скриншоты, которые агент снял, но не перечислил, тоже показываем.
    for (const f of fs
      .readdirSync(dir)
      .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
      .sort()) {
      const full = path.join(dir, f);
      if (!shots.some((x) => x.file === full)) shots.push({ file: full, caption: f });
    }
    const unverified = parseUnverified(res.text);
    if (unverified) {
      // Окружение не дало проверить (не поднялся API, нет входа): исполнитель тут не поможет — идём дальше, решает человек.
      const result: VisualResult = {
        at: new Date().toISOString(),
        url,
        blocking: [],
        notes: [...parsed.blocking, ...parsed.notes],
        shots,
        unverified,
        command,
        serverOutput: serverOut.trim() || undefined,
      };
      run.visuals = [...(run.visuals ?? []), result];
      k.log(
        run,
        c.amber(`! визуально проверить не удалось: ${unverified}`) +
          '\n' +
          c.dim(
            'Задача не возвращается исполнителю — проверьте сами во вкладке «Браузер». Тестовый вход и подготовку данных можно описать в «Инструкции для проверки» в командах проекта.',
          ) +
          '\n',
      );
      k.end(run, attempt, 'done', `Не удалось проверить: ${unverified}`);
      run.next = 'gate2';
      k.save(run);
      return;
    }
    const result: VisualResult = {
      at: new Date().toISOString(),
      url,
      blocking: parsed.blocking,
      notes: parsed.notes,
      shots,
      command,
      serverOutput: serverOut.trim() || undefined,
    };
    run.visuals = [...(run.visuals ?? []), result];
    if (result.blocking.length)
      k.log(
        run,
        c.coral(`✗ визуальные проблемы (${result.blocking.length}):\n`) +
          result.blocking.map((i) => `  • ${formatItem(i)}`).join('\n') +
          '\n',
      );
    k.log(run, c.dim(`скриншотов: ${shots.length}`) + '\n');
    k.end(
      run,
      attempt,
      result.blocking.length ? 'failed' : 'done',
      result.blocking.length
        ? `Проблем: ${result.blocking.length}, скриншотов: ${shots.length}`
        : `Выглядит верно, скриншотов: ${shots.length}`,
    );

    if (!result.blocking.length) {
      run.next = 'gate2';
      k.save(run);
      return;
    }
    run.feedback = {
      source: 'review',
      text:
        'Визуальная проверка в браузере нашла проблемы. Исправь каждую; скриншоты можно открыть инструментом Read:\n' +
        result.blocking.map((i) => `- ${formatItem(i)}`).join('\n') +
        (shots.length ? '\n\nСкриншоты:\n' + shots.map((x) => `- ${x.file} — ${x.caption}`).join('\n') : ''),
    };
    k.nextImplementOrLimit(run, 'Визуальная проверка снова нашла проблемы, а попытки реализации исчерпаны.');
  } finally {
    cast?.stop();
    k.emit({ type: 'visual.frame', runId: run.id, frame: null });
    await runProc('npx', ['-y', '@playwright/cli@latest', `-s=purpleflow-${run.id.slice(0, 8)}`, 'close'], {
      cwd: dir,
      env: k.opts.env,
      timeoutMs: 20_000,
    }).catch(() => undefined);
    await killGroup(serverGroup);
    // Профиль Chrome (десятки МБ) после проверки не нужен — скриншоты остаются.
    fs.rmSync(path.join(dir, 'chrome-profile'), { recursive: true, force: true });
  }
}

/**
 * Chrome без окна с портом отладки в группе процессов сервера (гаснет вместе с ним), pw подключается к нему.
 * null — Chrome не найден или не поднялся: агент откроет свой браузер через `pw open`, без трансляции.
 */
export async function startLiveBrowser(
  k: Kernel,
  run: RunFile,
  dir: string,
  url: string,
  group: string,
  session: string,
): Promise<{ cast: Screencast } | null> {
  const chrome = findChrome(k.opts.env);
  if (!chrome) return null;
  const port = await freePort();
  void runProc(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${path.join(dir, 'chrome-profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Плотность как у Retina: в трансляции и на скриншотах текст чёткий, а не растянутый вдвое.
      '--window-size=1440,900',
      '--force-device-scale-factor=2',
      url,
    ],
    { cwd: dir, env: k.opts.env, group },
  ).catch(() => undefined);
  if (!(await waitForCdp(port))) {
    k.log(run, c.dim('Chrome для трансляции не поднялся — агент откроет свой браузер.') + '\n');
    return null;
  }
  const att = await runProc('npx', ['-y', '@playwright/cli@latest', `-s=${session}`, 'attach', `--cdp=http://127.0.0.1:${port}`], {
    cwd: dir,
    env: k.opts.env,
    timeoutMs: 120_000,
  });
  if (att.code !== 0) {
    k.log(run, c.dim('pw не подключился к Chrome — агент откроет свой браузер.') + '\n');
    return null;
  }
  const cast = new Screencast(port, (frame) => k.emit({ type: 'visual.frame', runId: run.id, frame }));
  cast.start();
  k.log(run, c.dim('Браузер агента транслируется во вкладку «Браузер».') + '\n');
  return { cast };
}

/** Скриншот визуальной проверки для окна: data URL (только из каталога прогона). */
export function getVisualShot(k: Kernel, id: string, file: string): string | null {
  if (!fs.existsSync(file)) return null;
  // Сравниваем реальные пути: каталог данных может быть ссылкой.
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const root = real(path.join(k.opts.dataDir, 'visual', id));
  const full = real(file);
  if (!full.startsWith(root + path.sep)) return null;
  const ext = path.extname(full).slice(1).toLowerCase();
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext || 'png'};base64,${fs.readFileSync(full).toString('base64')}`;
}
