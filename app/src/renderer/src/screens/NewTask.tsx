import { useEffect, useRef, useState } from 'react';
import { Archive, Eraser, GitBranch, RotateCw, MonitorCheck, Sparkles } from 'lucide-react';
import type { GitGraph, ProjectBranches, ReviewTarget, Workspace, NextPartDraft } from '@purpleflow/core';
import { Button, Topbar } from '../components/ui';
import { Select } from '../components/Dropdown';
import { useStore } from '../lib/store';
import { FileDrop, type PickedFile } from '../components/FileDrop';
import { MODES, stagesFor, type Mode } from '../lib/stages';
import { MODE_ICON } from '../components/ModeIcon';
import { NotRepoNote, ProjectPicker, WORKSPACES, loadProject, projectName, saveLoaded, type LoadedProject } from './projects/common';
import { enabledList } from '../lib/tools';
import { bridge, cleanErr } from '../lib/api';

const LAST_PROJECT = 'purpleflow.lastProject';
const AUTOPILOT_KEY = 'purpleflow.autopilot';

const REVIEW_KINDS: { id: ReviewTarget['kind']; title: string; hint: string }[] = [
  { id: 'uncommitted', title: 'Незакоммиченное', hint: 'Правки в рабочей копии проекта, включая новые файлы' },
  { id: 'commit', title: 'Коммит', hint: 'Изменения одного коммита против его родителя' },
  { id: 'branch', title: 'Ветка', hint: 'Коммиты ветки, которых нет в другой ветке' },
  { id: 'files', title: 'Файлы', hint: 'Файлы целиком, как они есть в последнем коммите' },
];

export function NewTaskScreen({
  initialProject,
  draft,
  review,
}: {
  initialProject?: string;
  draft?: NextPartDraft;
  /** Открыть сразу в режиме «Ревью кода» с этой целью. */
  review?: ReviewTarget;
}) {
  const { go, state } = useStore();
  const [p, setP] = useState<LoadedProject | null>(null);
  const [task, setTask] = useState(draft?.task ?? '');
  /** Вложения прошлой части задачи — уйдут в новый прогон как есть. */
  const [carried, setCarried] = useState<string[]>(draft?.attachments ?? []);
  const [images, setImages] = useState<PickedFile[]>([]);
  const [mode, setMode] = useState<Mode>(review ? 'review' : 'task');
  // Ревью кода: что проверить. Поля всех видов живут отдельно — переключение вида не стирает выбранное.
  const [rKind, setRKind] = useState<ReviewTarget['kind']>(review?.kind ?? 'uncommitted');
  const [rCommit, setRCommit] = useState(review?.kind === 'commit' ? review.hash : '');
  const [rBranch, setRBranch] = useState(review?.kind === 'branch' ? review.branch : '');
  const [rAgainst, setRAgainst] = useState(review?.kind === 'branch' ? review.against : '');
  const [rFiles, setRFiles] = useState(review?.kind === 'files' ? review.files.join('\n') : '');
  const [graph, setGraph] = useState<GitGraph | null>(null);
  const [suggest, setSuggest] = useState<{ mode: Mode; reason: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [visual, setVisual] = useState(true);
  /** Автопилот запоминается между задачами. */
  const [autopilot, setAutopilotState] = useState(() => {
    try {
      return localStorage.getItem(AUTOPILOT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setAutopilot = (v: boolean) => {
    setAutopilotState(v);
    try {
      localStorage.setItem(AUTOPILOT_KEY, v ? '1' : '0');
    } catch {
      /* без памяти */
    }
  };
  /** Где работать — по умолчанию из настроек проекта, меняется для этой задачи. */
  const [workspace, setWorkspace] = useState<Workspace>('worktree');
  /** От какой ветки начать задачу; по умолчанию — текущая ветка проекта. */
  const [branches, setBranches] = useState<ProjectBranches | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const starting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /** «Отменить изменения» — со второго нажатия: изменения пропадут безвозвратно. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [cleaning, setCleaning] = useState<'stash' | 'discard' | null>(null);

  /** Выбранная папка: ответ по прошлому проекту, пришедший позже, не должен лечь на новый. */
  const chosen = useRef<string | null>(null);
  const choose = async (dir: string | null) => {
    if (!dir) return;
    chosen.current = dir;
    const x = await loadProject(dir);
    if (chosen.current !== dir) return;
    setP(x);
    setWorkspace(x.multi ? 'worktree' : x.workspace);
    setBranches(null);
    setBaseBranch('');
    setGraph(null);
    if (x.info.isRepo) void loadBranches(dir, false);
    if (x.info.isRepo)
      void Promise.resolve()
        .then(() => bridge.core.getGitGraph(dir, 60))
        .then((g) => {
          if (chosen.current !== dir) return;
          setGraph(g);
          setRAgainst((cur) => cur || g.base || '');
        })
        .catch(() => {});
    try {
      localStorage.setItem(LAST_PROJECT, dir);
    } catch {
      /* без памяти о проекте */
    }
  };

  useEffect(() => {
    let last: string | null = initialProject ?? null;
    if (!last) {
      try {
        last = localStorage.getItem(LAST_PROJECT);
      } catch {
        /* нет хранилища */
      }
    }
    if (last) void choose(last).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- последний проект подставляется один раз, при открытии экрана
  }, []);

  const loadBranches = async (dir: string, fetch: boolean) => {
    setFetching(fetch);
    try {
      const b = await bridge.core.projectBranches(dir, fetch);
      if (chosen.current !== dir) return;
      setBranches(b);
      const preferred = draft?.baseBranch && b.branches.some((x) => x.name === draft.baseBranch) ? draft.baseBranch : null;
      // Проект стоит на ветке прошлого прогона (режим «Ветка»): по умолчанию — main/master, а не цепочка от неё.
      const main = ['main', 'master'].find((n) => b.branches.some((x) => x.name === n));
      const current = b.current && /^purpleflow\//.test(b.current) && main ? main : b.current;
      setBaseBranch((cur) => (cur && b.branches.some((x) => x.name === cur) ? cur : (preferred ?? current ?? b.branches[0]?.name ?? '')));
    } catch {
      if (chosen.current === dir) setBranches({ branches: [], current: null });
    } finally {
      if (chosen.current === dir) setFetching(false);
    }
  };

  const project = p?.info ?? null;
  const cmds = p?.cmds ?? { setup: '', lint: '', test: '', run: '', url: '' };
  const toProject = () => project && go({ name: 'project', path: project.path, tab: 'commands' });

  const reviewTarget = (): ReviewTarget | null => {
    if (rKind === 'uncommitted') return { kind: 'uncommitted' };
    if (rKind === 'commit') return rCommit ? { kind: 'commit', hash: rCommit } : null;
    if (rKind === 'branch')
      return rBranch && rAgainst && rBranch !== rAgainst ? { kind: 'branch', branch: rBranch, against: rAgainst } : null;
    const files = rFiles
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    return files.length ? { kind: 'files', files } : null;
  };
  const isReview = mode === 'review';

  const start = async (clean?: 'stash' | 'discard') => {
    if (!p || starting.current) return;
    const target = isReview ? reviewTarget() : null;
    if (isReview && !target) return;
    starting.current = true;
    try {
      if (clean) {
        setCleaning(clean);
        try {
          await bridge.core.cleanWorkingCopy(p.info.path, clean);
        } finally {
          setCleaning(null);
        }
      }
      setBusy(true);
      setError(null);
      setConfirmDiscard(false);
      // Команды, найденные по файлам проекта, запоминаются при первом запуске.
      if (!p.cfg) await saveLoaded({ ...p, path: p.info.path });
      const { runId } = await bridge.core.dispatch({
        type: 'run.start',
        input: {
          projectPath: p.info.path,
          task,
          testCommand: cmds.test,
          setupCommand: cmds.setup,
          lintCommand: cmds.lint,
          mode,
          ...(target ? { reviewTarget: target } : {}),
          visual: !isReview && canVisual && visual,
          autopilot,
          attachmentPaths: carried.length ? carried : undefined,
          runCommand: cmds.run,
          appUrl: cmds.url,
          visualNotes: p.visualNotes,
          envFiles: p.envFiles,
          workspace,
          baseBranch: baseBranch || undefined,
          attachments: await Promise.all(images.map(async (i) => ({ name: i.name, data: new Uint8Array(await i.file.arrayBuffer()) }))),
        },
      });
      setTask('');
      setCarried([]);
      images.forEach((i) => i.url && URL.revokeObjectURL(i.url));
      setImages([]);
      go({ name: 'run', runId });
    } catch (e) {
      starting.current = false;
      setError(cleanErr(e));
      setBusy(false);
    }
  };

  // В режиме «Ветка» прогон начинается только с чистой рабочей копии — предлагаем спрятать или отменить изменения прямо здесь.
  const dirtyError = Boolean(error && workspace === 'branch' && /незакоммиченные изменения/.test(error));

  const cleanAndStart = async (how: 'stash' | 'discard') => {
    if (!p || starting.current) return;
    if (how === 'discard' && !confirmDiscard) return setConfirmDiscard(true);
    await start(how);
  };

  // Одновременно агенты ведут не больше maxParallel прогонов — остальные встают в очередь.
  const active = state.runs.filter((r) => r.status === 'running').length;
  const limit = state.settings?.maxParallel ?? 2;
  const willQueue = active >= limit;
  const queuedCount = state.runs.filter((r) => r.status === 'queued').length;
  // Визуальная проверка всегда видна в маршруте и включается переключателем прямо в нём.
  const route = stagesFor(mode, true);
  const canStart = Boolean(project?.isRepo && (isReview ? reviewTarget() : task.trim().length > 5));
  const hasRunCmd = Boolean(cmds.run.trim() && cmds.url.trim());
  // Агент визуальной проверки из настроек должен быть на этой машине.
  // Не выбран — claude; выключен в настройках — первый включённый (так же решает ядро при старте прогона).
  const enabledAgents = enabledList(state.settings?.enabledAgents);
  const wantVisual = state.settings?.agents.visual ?? 'claude';
  const visualAgent = enabledAgents.includes(wantVisual) ? wantVisual : enabledAgents[0];
  const visualInfo = state.tools?.[visualAgent];
  const noVisualAgent = Boolean(visualInfo && (!visualInfo.path || visualInfo.error));
  const canVisual = hasRunCmd && !noVisualAgent;

  const askMode = async () => {
    if (task.trim().length < 6) return;
    setSuggesting(true);
    setError(null);
    try {
      const r = await bridge.core.suggestMode(task);
      setSuggest({ mode: r.mode as Mode, reason: r.reason });
      setMode(r.mode as Mode);
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="screen">
      <Topbar
        title={isReview ? 'Ревью кода' : 'Новая задача'}
        sub={isReview ? 'Только чтение: замечания без правок и коммита' : 'Простая задача: одно изменение OpenSpec в отдельной ветке'}
      >
        <ProjectPicker project={project} draft={Boolean(project?.isRepo && !p?.cfg)} onPick={(dir) => void choose(dir)} />
      </Topbar>
      <div className="scroll">
        <div className="newtask">
          <div className="newtask-main step-enter">
            {project && <NotRepoNote project={project} onRoot={(dir) => void choose(dir)} />}
            <div className="modes" role="radiogroup" aria-label="Режим">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={mode === m.id}
                  className={`mode ${mode === m.id ? 'is-on' : ''}`}
                  onClick={() => setMode(m.id)}
                  title={m.hint}
                >
                  {MODE_ICON[m.id]}
                  <span>{m.title}</span>
                  {suggest?.mode === m.id && <Sparkles size={12} className="mode-ai" />}
                </button>
              ))}
              <button
                className="mode mode-auto"
                onClick={() => void askMode()}
                disabled={suggesting || task.trim().length < 6}
                title={
                  task.trim().length < 6
                    ? 'Сначала опишите задачу — нейросеть подберёт режим по тексту'
                    : 'Нейросеть прочитает задачу и предложит режим'
                }
              >
                {suggesting ? <span className="spinner" /> : <Sparkles size={15} />}
                <span>{suggesting ? 'Определяю…' : 'Авто'}</span>
              </button>
            </div>
            <p className="mode-hint">
              {suggest && suggest.mode === mode ? (
                <>
                  <Sparkles size={13} /> {suggest.reason}
                </>
              ) : (
                MODES.find((m) => m.id === mode)?.hint
              )}
            </p>

            {isReview && (
              <div className="review-target bezel">
                <span className="review-target-label">Что проверить</span>
                <div className="segmented small" role="radiogroup" aria-label="Что проверить">
                  {REVIEW_KINDS.map((k) => (
                    <button
                      key={k.id}
                      role="radio"
                      aria-checked={rKind === k.id}
                      className={rKind === k.id ? 'is-on' : ''}
                      onClick={() => setRKind(k.id)}
                    >
                      {k.title}
                    </button>
                  ))}
                </div>
                <p className="muted review-target-hint">{REVIEW_KINDS.find((k) => k.id === rKind)!.hint}</p>
                {rKind === 'commit' && (
                  <Select<string>
                    mono
                    ariaLabel="Коммит"
                    value={rCommit}
                    minWidth={420}
                    disabled={!graph?.commits.length}
                    placeholder={graph ? 'коммитов нет' : 'загружаю…'}
                    onChange={setRCommit}
                    options={[
                      ...(rCommit && !graph?.commits.some((c) => c.hash === rCommit)
                        ? [{ value: rCommit, label: `${rCommit.slice(0, 7)}` }]
                        : []),
                      ...(graph?.commits.map((c) => ({ value: c.hash, label: `${c.hash.slice(0, 7)}  ${c.subject}`, hint: c.author })) ??
                        []),
                    ]}
                  />
                )}
                {rKind === 'branch' && (
                  <div className="review-branches">
                    <Select<string>
                      mono
                      ariaLabel="Ветка для ревью"
                      value={rBranch}
                      minWidth={220}
                      placeholder={branches ? 'выберите ветку' : 'загружаю…'}
                      disabled={!branches?.branches.length}
                      onChange={setRBranch}
                      options={branches?.branches.map((b) => ({ value: b.name, label: b.name })) ?? []}
                    />
                    <span className="muted">против</span>
                    <Select<string>
                      mono
                      ariaLabel="С какой веткой сравнить"
                      value={rAgainst}
                      minWidth={180}
                      placeholder="ветка"
                      disabled={!branches?.branches.length}
                      onChange={setRAgainst}
                      options={branches?.branches.map((b) => ({ value: b.name, label: b.name })) ?? []}
                    />
                  </div>
                )}
                {rKind === 'branch' && rBranch && rBranch === rAgainst && <p className="actionbar-error">Выберите две разные ветки</p>}
                {rKind === 'files' && (
                  <textarea
                    className="review-files"
                    aria-label="Файлы для ревью"
                    rows={3}
                    placeholder={'Путь от корня проекта — по одному в строке:\nsrc/api/payments.ts\nsrc/lib/auth.ts'}
                    value={rFiles}
                    onChange={(e) => setRFiles(e.target.value)}
                  />
                )}
              </div>
            )}
            <div className="task-sheet bezel">
              <label htmlFor="task" className="task-label">
                {isReview ? 'На что обратить внимание — необязательно' : 'Что сделать'}
              </label>
              <textarea
                id="task"
                className="task-input"
                placeholder={
                  isReview
                    ? 'Например: безопасность платёжного API и обработка ошибок. Пусто — обычное ревью.'
                    : 'Например: добавь функцию slugify(s) в src/strings.ts, которая переводит строку в kebab-case латиницей, и тест к ней.'
                }
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || (!e.metaKey && !e.ctrlKey) || !canStart) return;
                  e.preventDefault();
                  if (!e.repeat) void start();
                }}
                autoFocus
              />
              <div className="task-foot">
                <span className="muted">
                  {task.trim()
                    ? `${task.trim().length} символов`
                    : isReview
                      ? 'Ревьюер ничего не правит — исправления запустите сами после разбора'
                      : 'Опишите результат, а не шаги — план составит планировщик'}
                </span>
                <span className="kbd-hint">
                  <kbd>{bridge.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd>
                  <kbd>Enter</kbd>
                </span>
              </div>
              {carried.length > 0 && (
                <div className="carried">
                  <span className="muted">Из прошлой части задачи:</span>
                  {carried.map((f) => (
                    <span key={f} className="carried-chip" title={f}>
                      {f.split('/').pop()?.replace(/^\d+-/, '')}
                      <button title="Не прикладывать" onClick={() => setCarried(carried.filter((x) => x !== f))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <FileDrop files={images} onChange={setImages} />
            </div>
          </div>

          <aside className="newtask-aside">
            <h3>Как пойдёт: {MODES.find((m) => m.id === mode)?.title.toLowerCase()}</h3>
            <ol className="route">
              {route.map((s, i) => {
                const optional = s.id === 'visual';
                const on = !optional || (canVisual && visual);
                const n = i + 1 - route.slice(0, i).filter((x) => x.gate || (x.id === 'visual' && !(canVisual && visual))).length;
                return (
                  <li
                    key={`${mode}-${s.id}`}
                    className={`${s.gate ? 'is-gate' : ''} ${optional ? 'is-optional' : ''} ${on ? '' : 'is-skipped'}`}
                    style={{ animationDelay: `${i * 0.04}s` }}
                  >
                    <span className="route-n">{s.gate ? '' : on ? n : <MonitorCheck size={12} />}</span>
                    <div>
                      <strong>{s.title}</strong>
                      {optional && noVisualAgent ? (
                        <span>Нужен {visualAgent} — на этой машине его нет; агента можно сменить в настройках моделей</span>
                      ) : optional && !canVisual ? (
                        <span>
                          Нужна команда запуска приложения —{' '}
                          {project?.isRepo ? (
                            <button className="link" onClick={toProject}>
                              задайте в настройках проекта
                            </button>
                          ) : (
                            'задайте в настройках проекта'
                          )}
                        </span>
                      ) : (
                        <span>{s.hint}</span>
                      )}
                    </div>
                    {optional && (
                      <button
                        role="switch"
                        aria-checked={on}
                        aria-label="Визуальная проверка"
                        className={`switch is-mini ${on ? 'is-on' : ''}`}
                        disabled={!canVisual}
                        onClick={() => setVisual(!visual)}
                      >
                        <i />
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
            {isReview ? (
              <p className="route-note">
                <GitBranch size={14} />
                <span>Код для ревью — в отдельной копии: ваша рабочая папка, ветки и индекс не меняются.</span>
              </p>
            ) : (
              <>
                <div className="autopilot">
                  <div>
                    <strong>Автопилот</strong>
                    <span>
                      План принимается сам, при исчерпанных попытках — ещё одна сама. Вы нужны на приёмке, а также если у планировщика
                      вопросы или он предлагает разбить задачу.
                    </span>
                  </div>
                  <button
                    role="switch"
                    aria-checked={autopilot}
                    aria-label="Автопилот"
                    className={`switch is-mini ${autopilot ? 'is-on' : ''}`}
                    onClick={() => setAutopilot(!autopilot)}
                  >
                    <i />
                  </button>
                </div>
                <div className="workspace">
                  <div className="workspace-head">
                    <strong>Где работать</strong>
                    {!p?.multi && (
                      <div className="segmented small" role="radiogroup">
                        {WORKSPACES.map((w) => (
                          <button
                            key={w.id}
                            role="radio"
                            aria-checked={workspace === w.id}
                            className={workspace === w.id ? 'is-on' : ''}
                            onClick={() => setWorkspace(w.id)}
                          >
                            {w.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="route-note">
                    <GitBranch size={14} />
                    <span>
                      {p?.multi
                        ? `Отдельные копии всех репозиториев проекта на одной ветке задачи — ваши рабочие папки не меняются. «От ветки» — для основного (${projectName(p.info.path)}), остальные начнут от своих текущих веток.`
                        : WORKSPACES.find((w) => w.id === workspace)!.hint}
                    </span>
                  </p>
                  {project?.isRepo && (
                    <div className="base-branch">
                      <span className="base-branch-label">От ветки</span>
                      <Select<string>
                        className="base-branch-select"
                        mono
                        title="Ветка, от которой начать задачу — переходить в неё в проекте не нужно"
                        ariaLabel="Ветка, от которой начать"
                        value={baseBranch}
                        minWidth={240}
                        disabled={!branches?.branches.length}
                        placeholder={branches ? 'веток нет' : 'загружаю…'}
                        onChange={setBaseBranch}
                        options={
                          branches?.branches.map((b) => ({
                            value: b.name,
                            label: b.name,
                            hint: b.name === branches.current ? 'текущая' : undefined,
                          })) ?? []
                        }
                      />
                      <button
                        className="side-icon base-branch-fetch"
                        title="Подтянуть ветки с origin (git fetch)"
                        disabled={fetching}
                        onClick={() => project && void loadBranches(project.path, true)}
                      >
                        <RotateCw size={14} className={fetching ? 'spin' : ''} />
                      </button>
                    </div>
                  )}
                  {branches && baseBranch && branches.current && baseBranch !== branches.current && (
                    <p className="base-branch-note">
                      Задача начнётся от <code>{baseBranch}</code>, хотя проект сейчас на <code>{branches.current}</code>
                      {workspace === 'branch'
                        ? ' — в режиме «Ветка» проект переключится на ветку задачи'
                        : ' — ваша рабочая копия не изменится'}
                      .
                    </p>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
      <footer className="actionbar">
        {error && <span className="actionbar-error">{error}</span>}
        {dirtyError && (
          <span className="dirty-actions">
            <Button
              tone="quiet"
              icon={<Archive size={14} />}
              busy={cleaning === 'stash'}
              disabled={Boolean(cleaning) || busy}
              title="git stash --include-untracked: изменения сохранятся, вернуть — git stash pop"
              onClick={() => void cleanAndStart('stash')}
            >
              Спрятать и запустить
            </Button>
            <Button
              tone={confirmDiscard ? 'danger' : 'quiet'}
              icon={<Eraser size={14} />}
              busy={cleaning === 'discard'}
              disabled={Boolean(cleaning) || busy}
              title="git reset --hard и git clean -fd: правки и новые файлы удалятся безвозвратно; игнорируемые (.env, node_modules) останутся"
              onClick={() => void cleanAndStart('discard')}
              onBlur={() => confirmDiscard && setTimeout(() => setConfirmDiscard(false), 150)}
            >
              {confirmDiscard ? 'Точно удалить изменения?' : 'Очистить и запустить'}
            </Button>
          </span>
        )}
        {willQueue && !error && (
          <span className="muted">
            Сейчас идут {active} из {limit} прогонов{queuedCount ? `, в очереди ${queuedCount}` : ''} — этот встанет в очередь и начнётся
            сам.
          </span>
        )}
        <span className="grow" />
        <Button tone="primary" busy={busy} disabled={!canStart} onClick={() => void start()}>
          {willQueue ? 'Поставить в очередь' : 'Запустить прогон'}
        </Button>
      </footer>
    </div>
  );
}
