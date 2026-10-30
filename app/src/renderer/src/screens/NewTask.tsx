import { useEffect, useState } from 'react';
import { Archive, ChevronDown, Eraser, GitBranch, RotateCw, MonitorCheck, Sparkles, TriangleAlert } from 'lucide-react';
import type { ProjectBranches, Workspace, NextPartDraft } from '@purpleflow/core';
import { Button, Topbar } from '../components/ui';
import { Select } from '../components/Dropdown';
import { useStore } from '../lib/store';
import { FileDrop, type PickedFile } from '../components/FileDrop';
import { MODES, stagesFor, type Mode } from '../lib/stages';
import { MODE_ICON } from '../components/ModeIcon';
import { ProjectPicker, WORKSPACES, cleanErr, loadProject, saveLoaded, type LoadedProject } from './Projects';

const LAST_PROJECT = 'purpleflow.lastProject';
const AUTOPILOT_KEY = 'purpleflow.autopilot';

export function NewTaskScreen({ initialProject, draft }: { initialProject?: string; draft?: NextPartDraft }) {
  const { go, state } = useStore();
  const [p, setP] = useState<LoadedProject | null>(null);
  const [task, setTask] = useState(draft?.task ?? '');
  /** Вложения прошлой части задачи — уйдут в новый прогон как есть. */
  const [carried, setCarried] = useState<string[]>(draft?.attachments ?? []);
  const [images, setImages] = useState<PickedFile[]>([]);
  const [mode, setMode] = useState<Mode>('task');
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
    } catch { /* без памяти */ }
  };
  /** Где работать — по умолчанию из настроек проекта, меняется для этой задачи. */
  const [workspace, setWorkspace] = useState<Workspace>('worktree');
  /** От какой ветки начать задачу; по умолчанию — текущая ветка проекта. */
  const [branches, setBranches] = useState<ProjectBranches | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** «Отменить изменения» — со второго нажатия: изменения пропадут безвозвратно. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [cleaning, setCleaning] = useState<'stash' | 'discard' | null>(null);

  const choose = async (dir: string | null) => {
    if (!dir) return;
    const x = await loadProject(dir);
    setP(x);
    setWorkspace(x.workspace);
    setBranches(null);
    setBaseBranch('');
    if (x.info.isRepo) void loadBranches(dir, false);
    try {
      localStorage.setItem(LAST_PROJECT, dir);
    } catch { /* без памяти о проекте */ }
  };

  useEffect(() => {
    let last: string | null = initialProject ?? null;
    if (!last) {
      try {
        last = localStorage.getItem(LAST_PROJECT);
      } catch { /* нет хранилища */ }
    }
    if (last) void choose(last).catch(() => {});
  }, []);

  const loadBranches = async (dir: string, fetch: boolean) => {
    setFetching(fetch);
    try {
      const b = await window.purpleflow.core.projectBranches(dir, fetch);
      setBranches(b);
      const preferred = draft?.baseBranch && b.branches.some((x) => x.name === draft.baseBranch) ? draft.baseBranch : null;
      setBaseBranch((cur) => (cur && b.branches.some((x) => x.name === cur) ? cur : preferred ?? b.current ?? b.branches[0]?.name ?? ''));
    } catch {
      setBranches({ branches: [], current: null });
    } finally {
      setFetching(false);
    }
  };

  const project = p?.info ?? null;
  const cmds = p?.cmds ?? { setup: '', lint: '', test: '', run: '', url: '' };
  const toProject = () => project && go({ name: 'project', path: project.path, tab: 'commands' });

  const start = async () => {
    if (!p) return;
    setBusy(true);
    setError(null);
    setConfirmDiscard(false);
    try {
      // Команды, найденные по файлам проекта, запоминаются при первом запуске.
      if (!p.cfg) await saveLoaded({ ...p, path: p.info.path });
      const { runId } = await window.purpleflow.core.dispatch({
        type: 'run.start',
        input: {
          projectPath: p.info.path, task, testCommand: cmds.test, setupCommand: cmds.setup, lintCommand: cmds.lint,
          mode, visual: canVisual && visual, autopilot, attachmentPaths: carried.length ? carried : undefined, runCommand: cmds.run, appUrl: cmds.url, visualNotes: p.visualNotes, envFiles: p.envFiles, workspace, baseBranch: baseBranch || undefined,
          attachments: await Promise.all(images.map(async (i) => ({ name: i.name, data: new Uint8Array(await i.file.arrayBuffer()) }))),
        },
      });
      setTask('');
      setCarried([]);
      images.forEach((i) => i.url && URL.revokeObjectURL(i.url));
      setImages([]);
      go({ name: 'run', runId });
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  // В режиме «Ветка» прогон начинается только с чистой рабочей копии — предлагаем спрятать или отменить изменения прямо здесь.
  const dirtyError = Boolean(error && workspace === 'branch' && /незакоммиченные изменения/.test(error));

  const cleanAndStart = async (how: 'stash' | 'discard') => {
    if (!p) return;
    if (how === 'discard' && !confirmDiscard) return setConfirmDiscard(true);
    setCleaning(how);
    try {
      await window.purpleflow.core.cleanWorkingCopy(p.info.path, how);
    } catch (e) {
      setError(cleanErr(e));
      setCleaning(null);
      return;
    }
    setCleaning(null);
    await start();
  };

  // Одновременно агенты ведут не больше maxParallel прогонов — остальные встают в очередь.
  const active = state.runs.filter((r) => r.status === 'running').length;
  const limit = state.settings?.maxParallel ?? 2;
  const willQueue = active >= limit;
  const queuedCount = state.runs.filter((r) => r.status === 'queued').length;
  // Визуальная проверка всегда видна в маршруте и включается переключателем прямо в нём.
  const route = stagesFor(mode, true);
  const canStart = Boolean(project?.isRepo && task.trim().length > 5);
  const hasRunCmd = Boolean(cmds.run.trim() && cmds.url.trim());
  // Агент визуальной проверки из настроек должен быть на этой машине.
  const visualAgent = state.settings?.agents.visual ?? 'claude';
  const visualInfo = state.tools?.[visualAgent];
  const noVisualAgent = Boolean(visualInfo && (!visualInfo.path || visualInfo.error));
  const canVisual = hasRunCmd && !noVisualAgent;

  const askMode = async () => {
    if (task.trim().length < 6) return;
    setSuggesting(true);
    setError(null);
    try {
      const r = await window.purpleflow.core.suggestMode(task);
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
      <Topbar title="Новая задача" sub="Простая задача: одно изменение OpenSpec в отдельной ветке">
        <ProjectPicker project={project} draft={Boolean(project?.isRepo && !p?.cfg)} onPick={(dir) => void choose(dir)} />
      </Topbar>
      <div className="scroll">
        <div className="newtask">
          <div className="newtask-main step-enter">
            {project && !project.isRepo && (
              <p className="inline-error"><TriangleAlert size={14} /> Это не git-репозиторий. Выполните git init и первый коммит.</p>
            )}
            <div className="modes" role="radiogroup" aria-label="Режим">
              {MODES.map((m) => (
                <button key={m.id} role="radio" aria-checked={mode === m.id} className={`mode ${mode === m.id ? 'is-on' : ''}`} onClick={() => setMode(m.id)} title={m.hint}>
                  {MODE_ICON[m.id]}
                  <span>{m.title}</span>
                  {suggest?.mode === m.id && <Sparkles size={12} className="mode-ai" />}
                </button>
              ))}
              <button className="mode mode-auto" onClick={() => void askMode()} disabled={suggesting || task.trim().length < 6} title={task.trim().length < 6 ? 'Сначала опишите задачу — нейросеть подберёт режим по тексту' : 'Нейросеть прочитает задачу и предложит режим'}>
                {suggesting ? <span className="spinner" /> : <Sparkles size={15} />}
                <span>{suggesting ? 'Определяю…' : 'Авто'}</span>
              </button>
            </div>
            <p className="mode-hint">
              {suggest && suggest.mode === mode ? <><Sparkles size={13} /> {suggest.reason}</> : MODES.find((m) => m.id === mode)?.hint}
            </p>

            <div className="task-sheet bezel">
              <label htmlFor="task" className="task-label">Что сделать</label>
              <textarea
                id="task"
                className="task-input"
                placeholder="Например: добавь функцию slugify(s) в src/strings.ts, которая переводит строку в kebab-case латиницей, и тест к ней."
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canStart) void start();
                }}
                autoFocus
              />
              <div className="task-foot">
                <span className="muted">{task.trim() ? `${task.trim().length} символов` : 'Опишите результат, а не шаги — план составит планировщик'}</span>
                <span className="kbd-hint"><kbd>{window.purpleflow.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd><kbd>Enter</kbd></span>
              </div>
              {carried.length > 0 && (
                <div className="carried">
                  <span className="muted">Из прошлой части задачи:</span>
                  {carried.map((f) => (
                    <span key={f} className="carried-chip" title={f}>
                      {f.split('/').pop()?.replace(/^\d+-/, '')}
                      <button title="Не прикладывать" onClick={() => setCarried(carried.filter((x) => x !== f))}>×</button>
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
                  <li key={`${mode}-${s.id}`} className={`${s.gate ? 'is-gate' : ''} ${optional ? 'is-optional' : ''} ${on ? '' : 'is-skipped'}`} style={{ animationDelay: `${i * 0.04}s` }}>
                    <span className="route-n">{s.gate ? '' : on ? n : <MonitorCheck size={12} />}</span>
                    <div>
                      <strong>{s.title}</strong>
                      {optional && noVisualAgent ? (
                        <span>Нужен {visualAgent} — на этой машине его нет; агента можно сменить в настройках моделей</span>
                      ) : optional && !canVisual ? (
                        <span>
                          Нужна команда запуска приложения —{' '}
                          {project?.isRepo ? <button className="link" onClick={toProject}>задайте в настройках проекта</button> : 'задайте в настройках проекта'}
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
            <div className="autopilot">
              <div>
                <strong>Автопилот</strong>
                <span>План принимается сам, при исчерпанных попытках — ещё одна сама. Вы нужны на приёмке, а также если у планировщика вопросы или он предлагает разбить задачу.</span>
              </div>
              <button role="switch" aria-checked={autopilot} aria-label="Автопилот" className={`switch is-mini ${autopilot ? 'is-on' : ''}`} onClick={() => setAutopilot(!autopilot)}>
                <i />
              </button>
            </div>
            <div className="workspace">
              <div className="workspace-head">
                <strong>Где работать</strong>
                <div className="segmented small" role="radiogroup">
                  {WORKSPACES.map((w) => (
                    <button key={w.id} role="radio" aria-checked={workspace === w.id} className={workspace === w.id ? 'is-on' : ''} onClick={() => setWorkspace(w.id)}>
                      {w.title}
                    </button>
                  ))}
                </div>
              </div>
              <p className="route-note">
                <GitBranch size={14} />
                <span>{WORKSPACES.find((w) => w.id === workspace)!.hint}</span>
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
                    options={branches?.branches.map((b) => ({ value: b.name, label: b.name, hint: b.name === branches.current ? 'текущая' : undefined })) ?? []}
                  />
                  <button className="side-icon base-branch-fetch" title="Подтянуть ветки с origin (git fetch)" disabled={fetching} onClick={() => project && void loadBranches(project.path, true)}>
                    <RotateCw size={14} className={fetching ? 'spin' : ''} />
                  </button>
                </div>
              )}
              {branches && baseBranch && branches.current && baseBranch !== branches.current && (
                <p className="base-branch-note">Задача начнётся от <code>{baseBranch}</code>, хотя проект сейчас на <code>{branches.current}</code>{workspace === 'branch' ? ' — в режиме «Ветка» проект переключится на ветку задачи' : ' — ваша рабочая копия не изменится'}.</p>
              )}
            </div>
          </aside>
        </div>
      </div>
      <footer className="actionbar">
        {error && <span className="actionbar-error">{error}</span>}
        {dirtyError && (
          <span className="dirty-actions">
            <Button tone="quiet" icon={<Archive size={14} />} busy={cleaning === 'stash'} disabled={Boolean(cleaning) || busy} title="git stash --include-untracked: изменения сохранятся, вернуть — git stash pop" onClick={() => void cleanAndStart('stash')}>
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
        {willQueue && !error && <span className="muted">Сейчас идут {active} из {limit} прогонов{queuedCount ? `, в очереди ${queuedCount}` : ''} — этот встанет в очередь и начнётся сам.</span>}
        <span className="grow" />
        <Button tone="primary" busy={busy} disabled={!canStart} onClick={() => void start()}>{willQueue ? "Поставить в очередь" : "Запустить прогон"}</Button>
      </footer>
    </div>
  );
}
