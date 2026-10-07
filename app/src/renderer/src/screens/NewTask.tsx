import { useEffect, useState, type ReactNode } from 'react';
import { Check, FolderGit2, FolderOpen, GitBranch, PackageOpen, ScanSearch, Sparkles, TestTubeDiagonal, TriangleAlert } from 'lucide-react';
import type { ProjectCommands } from '@psflow/core';
import { Button, Input, Topbar } from '../components/ui';
import { PillTabs } from '../components/PillTabs';
import { useStore } from '../lib/store';
import { ImageDrop, type PickedImage } from '../components/ImageDrop';
import { STAGES } from '../lib/stages';
import { shortPath } from '../lib/format';

type Project = ProjectCommands & { isRepo: boolean; name: string; path: string };
type Tab = 'task' | 'commands';
type Cmd = 'setup' | 'lint' | 'test';

const LAST_PROJECT = 'psflow.lastProject';
const cleanErr = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function NewTaskScreen() {
  const { go, state } = useStore();
  const [tab, setTab] = useState<Tab>('task');
  /** Команды проекта сохранены (или ещё черновик из автоопределения). */
  const [saved, setSaved] = useState<'saved' | 'draft' | 'dirty'>('draft');
  const [saving, setSaving] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [task, setTask] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [cmds, setCmds] = useState<Record<Cmd, string>>({ setup: '', lint: '', test: '' });
  /** Откуда взята каждая команда: файл проекта, нейросеть или правка руками. */
  const [notes, setNotes] = useState<Record<Cmd, string>>({ setup: '', lint: '', test: '' });
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDone, setAiDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (dir: string | null) => {
    if (!dir) return;
    const info = await window.psflow.core.detectProject(dir);
    setProject({ ...info, path: dir });
    setAiDone(false);
    const cfg = info.isRepo ? await window.psflow.core.getProjectConfig(dir).catch(() => null) : null;
    if (cfg) {
      setCmds({ setup: cfg.setupCommand, lint: cfg.lintCommand, test: cfg.testCommand });
      setNotes(cfg.notes);
      setSaved('saved');
    } else {
      setCmds({ setup: info.setupCommand, lint: info.lintCommand, test: info.testCommand });
      const from = info.detectedFrom ? `по ${info.detectedFrom}` : '';
      setNotes({ setup: info.setupCommand ? from : '', lint: info.lintCommand ? from : '', test: info.testCommand ? from : '' });
      setSaved('draft');
    }
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

  const detectAI = async () => {
    if (!project) return;
    setAiBusy(true);
    setError(null);
    try {
      const r = await window.psflow.core.detectCommandsAI(project.path);
      setCmds({ setup: r.setupCommand, lint: r.lintCommand, test: r.testCommand });
      setNotes({ setup: r.notes.setup, lint: r.notes.lint, test: r.notes.test });
      setAiDone(true);
      setSaved('dirty');
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setAiBusy(false);
    }
  };

  const saveCommands = async () => {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      await window.psflow.core.saveProjectConfig(project.path, { setupCommand: cmds.setup, lintCommand: cmds.lint, testCommand: cmds.test, notes });
      setSaved('saved');
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      // Команды проекта, которые ещё не сохраняли, запоминаются при первом запуске.
      if (saved !== 'saved') await saveCommands();
      const { runId } = await window.psflow.core.dispatch({
        type: 'run.start',
        input: {
          projectPath: project.path, task, testCommand: cmds.test, setupCommand: cmds.setup, lintCommand: cmds.lint,
          attachments: await Promise.all(images.map(async (i) => ({ name: i.name, data: new Uint8Array(await i.file.arrayBuffer()) }))),
        },
      });
      setTask('');
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
      setTab('task');
      go({ name: 'run', runId });
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const busyRun = state.runs.find((r) => r.status === 'running');
  const canStart = Boolean(project?.isRepo && task.trim().length > 5) && !busyRun;
  const edit = (k: Cmd, v: string) => {
    setCmds({ ...cmds, [k]: v });
    setNotes({ ...notes, [k]: v ? 'указано вручную' : '' });
    setSaved('dirty');
  };
  const summary = [cmds.setup, cmds.lint, cmds.test].filter(Boolean);

  return (
    <div className="screen">
      <Topbar title="Новая задача" sub="Простая задача: одно изменение OpenSpec в отдельной ветке" />
      <div className="page-tabs">
        <PillTabs<Tab>
          className="tabs"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'task', label: 'Задача' },
            {
              id: 'commands',
              label: 'Команды проекта',
              disabled: !project?.isRepo,
              extra: project?.isRepo && saved !== 'saved' ? <span className="tab-dot" title="Не сохранены" /> : undefined,
            },
          ]}
        />
      </div>
      <div className="scroll">
        <div className="newtask">
          <div className="newtask-main step-enter" key={tab}>
            {tab === 'task' ? (
              <>
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
                {project?.isRepo && (
                  <button className="cmd-summary" onClick={() => setTab('commands')}>
                    <span className="muted">Команды проекта</span>
                    {summary.length ? summary.map((c, i) => <code key={i}>{c}</code>) : <span className="muted">не заданы — проверки будут пропущены</span>}
                    <span className="grow" />
                    {saved !== 'saved' && <span className="cmd-unsaved">проверьте и сохраните</span>}
                    <span className="cmd-edit">Настроить</span>
                  </button>
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
              </>
            ) : (
              <section className="panel commands">
                <header className="panel-head">
                  <div>
                    <h2>Команды проекта {project?.name}</h2>
                    <p>Настраиваются один раз для проекта и подставляются в каждую задачу. Подготовка — один раз перед планом, линтер и тесты — после каждой реализации. Пустое поле — шаг пропускается.</p>
                  </div>
                  <Button tone={aiDone ? 'ghost' : 'primary'} icon={<Sparkles size={15} />} busy={aiBusy} onClick={() => void detectAI()}>
                    {aiBusy ? 'Нейросеть изучает проект…' : aiDone ? 'Найти заново' : 'Найти нейросетью'}
                  </Button>
                </header>
                <div className="cmd-list">
                  <CmdRow icon={<PackageOpen size={17} />} title="Подготовка" hint="Установка зависимостей" placeholder="не нужна" value={cmds.setup} note={notes.setup} onChange={(v) => edit('setup', v)} loading={aiBusy} />
                  <CmdRow icon={<ScanSearch size={17} />} title="Линтер" hint="Линтер и проверка типов" placeholder="не задан" value={cmds.lint} note={notes.lint} onChange={(v) => edit('lint', v)} loading={aiBusy} />
                  <CmdRow icon={<TestTubeDiagonal size={17} />} title="Тесты" hint="Все тесты, без watch-режима" placeholder="не заданы" value={cmds.test} note={notes.test} onChange={(v) => edit('test', v)} loading={aiBusy} />
                </div>
                <div className="cmd-actions">
                  <p className="cmd-foot">Нейросеть только читает файлы проекта — package.json, конфиги, CI — и ничего не меняет.</p>
                  <span className="grow" />
                  {saved === 'saved' ? <span className="cmd-saved"><Check size={14} /> Сохранено для проекта</span> : (
                    <Button tone="ghost" busy={saving} onClick={() => void saveCommands()}>Сохранить для проекта</Button>
                  )}
                </div>
              </section>
            )}
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
              <GitBranch size={14} /> <span>Результат — коммит в ветке <code>psflow/&lt;id&gt;</code>. Влить можно кнопкой в конце прогона.</span>
            </p>
          </aside>
        </div>
      </div>
      <footer className="actionbar">
        {error && <span className="actionbar-error">{error}</span>}
        {busyRun && !error && <span className="muted">Сейчас идёт «{busyRun.title}». Дождитесь гейта или остановите его — в прототипе один прогон за раз.</span>}
        <span className="grow" />
        <Button tone="primary" busy={busy} disabled={!canStart} onClick={() => void start()}>Запустить прогон</Button>
      </footer>
    </div>
  );
}

function CmdRow({ icon, title, hint, placeholder, value, note, onChange, loading }: {
  icon: ReactNode; title: string; hint: string; placeholder: string; value: string; note: string; onChange: (v: string) => void; loading: boolean;
}) {
  return (
    <div className={`cmd-row ${loading ? 'is-loading' : ''}`}>
      <span className="cmd-icon">{icon}</span>
      <div className="cmd-label">
        <strong>{title}</strong>
        <span>{hint}</span>
      </div>
      <div className="cmd-field">
        <Input mono placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
        {note && <span className="cmd-note" title={note}>{note}</span>}
      </div>
    </div>
  );
}
