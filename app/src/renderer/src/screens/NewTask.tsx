import { useEffect, useState } from 'react';
import { FolderGit2, FolderOpen, GitBranch, TriangleAlert } from 'lucide-react';
import type { ProjectCommands } from '@psflow/core';
import { Button, Field, Input, TextArea, Topbar } from '../components/ui';
import { useStore } from '../lib/store';
import { ImageDrop, type PickedImage } from '../components/ImageDrop';
import { STAGES } from '../lib/stages';
import { shortPath } from '../lib/format';

type Project = ProjectCommands & { isRepo: boolean; name: string; path: string };

const LAST_PROJECT = 'psflow.lastProject';

export function NewTaskScreen() {
  const { go, state } = useStore();
  const [project, setProject] = useState<Project | null>(null);
  const [task, setTask] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [testCommand, setTestCommand] = useState('');
  const [setupCommand, setSetupCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (dir: string | null) => {
    if (!dir) return;
    const info = await window.psflow.core.detectProject(dir);
    setProject({ ...info, path: dir });
    setTestCommand(info.testCommand);
    setSetupCommand(info.setupCommand);
    try {
      localStorage.setItem(LAST_PROJECT, dir);
    } catch { /* без памяти о проекте */ }
  };

  useEffect(() => {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT);
    } catch { /* нет хранилища */ }
    if (last) void choose(last).catch(() => {});
  }, []);

  const start = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const { runId } = await window.psflow.core.dispatch({
        type: 'run.start',
        input: {
          projectPath: project.path, task, testCommand, setupCommand,
          attachments: await Promise.all(images.map(async (i) => ({ name: i.name, data: new Uint8Array(await i.file.arrayBuffer()) }))),
        },
      });
      setTask('');
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
      go({ name: 'run', runId });
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };

  const busyRun = state.runs.find((r) => r.status === 'running');
  const canStart = Boolean(project?.isRepo && task.trim().length > 5 && !busyRun);

  return (
    <div className="screen">
      <Topbar title="Новая задача" sub="Простая задача: одно изменение OpenSpec в отдельной ветке" />
      <div className="scroll">
        <div className="newtask">
          <div className="newtask-main">
            <button className={`project ${project ? (project.isRepo ? 'is-ok' : 'is-bad') : ''}`} onClick={async () => choose(await window.psflow.pickFolder())}>
              <span className="project-icon">{project ? <FolderGit2 size={20} /> : <FolderOpen size={20} />}</span>
              <span className="project-text">
                {project ? (
                  <>
                    <strong>{project.name}</strong>
                    <span className="mono">{shortPath(project.path)}</span>
                  </>
                ) : (
                  <>
                    <strong>Выберите папку проекта</strong>
                    <span>Git-репозиторий. Ваша рабочая копия не изменится — работа идёт в отдельной worktree.</span>
                  </>
                )}
              </span>
              <span className="project-change">{project ? 'Сменить' : 'Обзор'}</span>
            </button>
            {project && !project.isRepo && (
              <p className="inline-error"><TriangleAlert size={14} /> Это не git-репозиторий. Выполните git init и первый коммит.</p>
            )}

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

            <div className="grid-2">
              <Field
                label="Команда тестов"
                hint={project?.detectedFrom ? `Определено из ${project.detectedFrom}` : 'Пусто — стадия тестов пропускается'}
              >
                <Input mono placeholder="npm test" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} />
              </Field>
              <Field label="Подготовка worktree" hint="Один раз перед планом, например установка зависимостей">
                <Input mono placeholder="не нужна" value={setupCommand} onChange={(e) => setSetupCommand(e.target.value)} />
              </Field>
            </div>
          </div>

          <aside className="newtask-aside">
            <h3>Как пойдёт задача</h3>
            <ol className="route">
              {STAGES.map((s, i) => (
                <li key={s.id} className={s.gate ? 'is-gate' : ''}>
                  <span className="route-n">{s.gate ? '' : i + 1 - STAGES.slice(0, i).filter((x) => x.gate).length}</span>
                  <div>
                    <strong>{s.title}</strong>
                    <span>{s.hint}</span>
                  </div>
                </li>
              ))}
            </ol>
            <p className="route-note">
              <GitBranch size={14} /> <span>Результат — коммит в ветке <code>psflow/&lt;id&gt;</code>. Слияние делаете вы.</span>
            </p>
          </aside>
        </div>
      </div>
      <footer className="actionbar">
        {error && <span className="actionbar-error">{error}</span>}
        {busyRun && !error && <span className="muted">Сейчас идёт «{busyRun.title}». Дождитесь гейта или остановите его — в прототипе один прогон за раз.</span>}
        <span className="grow" />
        <Button tone="primary" busy={busy} disabled={!canStart} onClick={() => void start()}>
          Запустить прогон
        </Button>
      </footer>
    </div>
  );
}
