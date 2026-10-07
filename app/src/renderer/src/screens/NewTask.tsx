import { useEffect, useState } from 'react';
import { GitBranch, MonitorCheck, Sparkles, TriangleAlert } from 'lucide-react';
import type { Workspace } from '@psflow/core';
import { Button, Topbar } from '../components/ui';
import { useStore } from '../lib/store';
import { ImageDrop, type PickedImage } from '../components/ImageDrop';
import { MODES, stagesFor, type Mode } from '../lib/stages';
import { MODE_ICON } from '../components/ModeIcon';
import { ProjectPicker, WORKSPACES, cleanErr, loadProject, saveLoaded, type LoadedProject } from './Projects';

const LAST_PROJECT = 'psflow.lastProject';

export function NewTaskScreen({ initialProject }: { initialProject?: string }) {
  const { go, state } = useStore();
  const [p, setP] = useState<LoadedProject | null>(null);
  const [task, setTask] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [mode, setMode] = useState<Mode>('task');
  const [suggest, setSuggest] = useState<{ mode: Mode; reason: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [visual, setVisual] = useState(true);
  /** Где работать — по умолчанию из настроек проекта, меняется для этой задачи. */
  const [workspace, setWorkspace] = useState<Workspace>('worktree');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (dir: string | null) => {
    if (!dir) return;
    const x = await loadProject(dir);
    setP(x);
    setWorkspace(x.workspace);
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

  const project = p?.info ?? null;
  const cmds = p?.cmds ?? { setup: '', lint: '', test: '', run: '', url: '' };
  const toProject = () => project && go({ name: 'project', path: project.path, tab: 'commands' });

  const start = async () => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      // Команды, найденные по файлам проекта, запоминаются при первом запуске.
      if (!p.cfg) await saveLoaded({ ...p, path: p.info.path });
      const { runId } = await window.psflow.core.dispatch({
        type: 'run.start',
        input: {
          projectPath: p.info.path, task, testCommand: cmds.test, setupCommand: cmds.setup, lintCommand: cmds.lint,
          mode, visual: canVisual && visual, runCommand: cmds.run, appUrl: cmds.url, visualNotes: p.visualNotes, envFiles: p.envFiles, workspace,
          attachments: await Promise.all(images.map(async (i) => ({ name: i.name, data: new Uint8Array(await i.file.arrayBuffer()) }))),
        },
      });
      setTask('');
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
      go({ name: 'run', runId });
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  // Одновременно агенты ведут не больше maxParallel прогонов — остальные встают в очередь.
  const active = state.runs.filter((r) => r.status === 'running').length;
  const limit = state.settings?.maxParallel ?? 2;
  const willQueue = active >= limit;
  const queuedCount = state.runs.filter((r) => r.status === 'queued').length;
  // Визуальная проверка всегда видна в маршруте и включается переключателем прямо в нём.
  const route = stagesFor(mode, true);
  const canStart = Boolean(project?.isRepo && task.trim().length > 5);
  const canVisual = Boolean(cmds.run.trim() && cmds.url.trim());

  const askMode = async () => {
    if (task.trim().length < 6) return;
    setSuggesting(true);
    setError(null);
    try {
      const r = await window.psflow.core.suggestMode(task);
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
                <span className="kbd-hint"><kbd>{window.psflow.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd><kbd>Enter</kbd></span>
              </div>
              <ImageDrop images={images} onChange={setImages} />
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
                      {optional && !canVisual ? (
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
            </div>
          </aside>
        </div>
      </div>
      <footer className="actionbar">
        {error && <span className="actionbar-error">{error}</span>}
        {willQueue && !error && <span className="muted">Сейчас идут {active} из {limit} прогонов{queuedCount ? `, в очереди ${queuedCount}` : ''} — этот встанет в очередь и начнётся сам.</span>}
        <span className="grow" />
        <Button tone="primary" busy={busy} disabled={!canStart} onClick={() => void start()}>{willQueue ? "Поставить в очередь" : "Запустить прогон"}</Button>
      </footer>
    </div>
  );
}
