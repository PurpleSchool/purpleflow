import { useEffect, useState, type ReactNode } from 'react';
import { Check, FileLock2, KeyRound, Minus, FolderGit2, FolderOpen, GitBranch, Globe, MonitorCheck, MonitorPlay, PackageOpen, ScanSearch, Sparkles, TestTubeDiagonal, TriangleAlert, X, Layers, FolderTree, Workflow, BookText, FlaskConical, Play, PencilLine, FileText, Lightbulb } from 'lucide-react';
import type { CommandIssue, ProjectCommands, ProjectKnowledge, Workspace } from '@psflow/core';
import { Button, Input, TextArea, Topbar } from '../components/ui';
import { PillTabs } from '../components/PillTabs';
import { Markdown } from '../components/Markdown';
import { useStore } from '../lib/store';
import { ImageDrop, type PickedImage } from '../components/ImageDrop';
import { MODES, stagesFor, type Mode } from '../lib/stages';
import { MODE_ICON } from '../components/ModeIcon';
import { shortPath } from '../lib/format';

type Project = ProjectCommands & { envFiles: string[]; isRepo: boolean; name: string; path: string };
type Tab = 'task' | 'commands' | 'knowledge';
type Cmd = 'setup' | 'lint' | 'test' | 'run' | 'url';

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
  const [cmds, setCmds] = useState<Record<Cmd, string>>({ setup: '', lint: '', test: '', run: '', url: '' });
  const [mode, setMode] = useState<Mode>('task');
  const [suggest, setSuggest] = useState<{ mode: Mode; reason: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [visual, setVisual] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace>('worktree');
  /** Инструкция агенту визуальной проверки: тестовый вход, сид данных. */
  const [visualNotes, setVisualNotes] = useState('');
  /** Файлы окружения для worktree — через запятую. */
  const [envFiles, setEnvFiles] = useState('');
  /** Найденные без запуска ошибки в командах: нет скрипта в package.json и т. п. */
  const [issues, setIssues] = useState<Record<string, CommandIssue[]>>({});
  /** Откуда взята каждая команда: файл проекта, нейросеть или правка руками. */
  const [notes, setNotes] = useState<Record<Cmd, string>>({ setup: '', lint: '', test: '', run: '', url: '' });
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
      setCmds({ setup: cfg.setupCommand, lint: cfg.lintCommand, test: cfg.testCommand, run: cfg.runCommand ?? '', url: cfg.appUrl ?? '' });
      setNotes({ ...cfg.notes, run: cfg.notes.run ?? '', url: '' });
      setWorkspace(cfg.workspace ?? 'worktree');
      setVisualNotes(cfg.visualNotes ?? '');
      setEnvFiles((cfg.envFiles ?? info.envFiles).join(', '));
      setSaved('saved');
    } else {
      setCmds({ setup: info.setupCommand, lint: info.lintCommand, test: info.testCommand, run: '', url: '' });
      const from = info.detectedFrom ? `по ${info.detectedFrom}` : '';
      setNotes({ setup: info.setupCommand ? from : '', lint: info.lintCommand ? from : '', test: info.testCommand ? from : '', run: '', url: '' });
      setWorkspace('worktree');
      setVisualNotes('');
      setEnvFiles(info.envFiles.join(', '));
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
      setCmds({ setup: r.setupCommand, lint: r.lintCommand, test: r.testCommand, run: r.runCommand, url: r.appUrl });
      if (r.visualNotes) setVisualNotes(r.visualNotes);
      setNotes({ setup: r.notes.setup, lint: r.notes.lint, test: r.notes.test, run: r.notes.run, url: '' });
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
      await window.psflow.core.saveProjectConfig(project.path, {
        setupCommand: cmds.setup, lintCommand: cmds.lint, testCommand: cmds.test, runCommand: cmds.run, appUrl: cmds.url, visualNotes, envFiles: envList, workspace,
        notes: { setup: notes.setup, lint: notes.lint, test: notes.test, run: notes.run },
      });
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
          mode, visual: canVisual && visual, runCommand: cmds.run, appUrl: cmds.url, visualNotes, envFiles: envList, workspace,
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

  useEffect(() => {
    if (!project?.isRepo) return setIssues({});
    const t = setTimeout(() => {
      void window.psflow.core.checkCommands(project.path, { setup: cmds.setup, lint: cmds.lint, test: cmds.test, run: cmds.run }).then(setIssues).catch(() => setIssues({}));
    }, 350);
    return () => clearTimeout(t);
  }, [project?.path, project?.isRepo, cmds.setup, cmds.lint, cmds.test, cmds.run]);

  // Одновременно агенты ведут не больше maxParallel прогонов — остальные встают в очередь.
  const active = state.runs.filter((r) => r.status === 'running').length;
  const limit = state.settings?.maxParallel ?? 2;
  const willQueue = active >= limit;
  const queuedCount = state.runs.filter((r) => r.status === 'queued').length;
  // Визуальная проверка всегда видна в маршруте и включается переключателем прямо в нём.
  const route = stagesFor(mode, true);
  const canStart = Boolean(project?.isRepo && task.trim().length > 5);
  const edit = (k: Cmd, v: string) => {
    setCmds({ ...cmds, [k]: v });
    setNotes({ ...notes, [k]: v ? 'указано вручную' : '' });
    setSaved('dirty');
  };
  const envList = envFiles.split(/[,\n]/).map((f) => f.trim()).filter(Boolean);
  const summary = [
    { label: 'Подготовка', value: cmds.setup },
    { label: 'Линтер', value: cmds.lint },
    { label: 'Тесты', value: cmds.test },
    { label: 'Запуск', value: cmds.run && cmds.url ? `${cmds.run}  →  ${cmds.url}` : '' },
  ].map((c) => ({ ...c, on: Boolean(c.value.trim()) }));
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
        <button
          className={`project is-compact ${project ? (project.isRepo ? 'is-ok' : 'is-bad') : ''}`}
          title={project ? project.path : 'Git-репозиторий проекта'}
          onClick={async () => choose(await window.psflow.pickFolder())}
        >
          <span className="project-icon">{project ? <FolderGit2 size={18} /> : <FolderOpen size={18} />}</span>
          <span className="project-text">
            {project ? (
              <>
                <strong>{project.name}</strong>
                <span className="mono">{shortPath(project.path)}</span>
              </>
            ) : (
              <>
                <strong>Выберите папку проекта</strong>
                <span>Git-репозиторий проекта</span>
              </>
            )}
          </span>
          <span className="project-change">{project ? 'Сменить' : 'Обзор'}</span>
        </button>
      </Topbar>
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
            { id: 'knowledge', label: 'Знания о проекте', disabled: !project?.isRepo },
          ]}
        />
      </div>
      <div className="scroll">
        <div className={`newtask ${tab === 'knowledge' ? 'is-single' : ''}`}>
          <div className="newtask-main step-enter" key={tab}>
            {tab === 'task' ? (
              <>
                {project && !project.isRepo && (
                  <p className="inline-error"><TriangleAlert size={14} /> Это не git-репозиторий. Выполните git init и первый коммит.</p>
                )}
                {project?.isRepo && (
                  <button className="cmd-summary" onClick={() => setTab('commands')}>
                    <span className="muted">Команды проекта</span>
                    {summary.map((c) => (
                      <span key={c.label} className={`cmd-chip ${c.on ? 'is-on' : ''}`} title={c.on ? c.value : 'Не задано — шаг пропускается'}>
                        {c.on ? <Check size={13} /> : <Minus size={13} />}
                        {c.label}
                      </span>
                    ))}
                    <span className="grow" />
                    {saved !== 'saved' && <span className="cmd-unsaved">проверьте и сохраните</span>}
                    <span className="cmd-edit">Настроить</span>
                  </button>
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
              </>
            ) : tab === 'knowledge' && project?.isRepo ? (
              <KnowledgeView repo={project.path} name={project.name} />
            ) : (
              <>
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
                  <CmdRow icon={<PackageOpen size={17} />} title="Подготовка" hint="Установка зависимостей" placeholder="не нужна" value={cmds.setup} note={notes.setup} onChange={(v) => edit('setup', v)} loading={aiBusy} issues={issues.setup} />
                  <CmdRow icon={<ScanSearch size={17} />} title="Линтер" hint="Линтер и проверка типов" placeholder="не задан" value={cmds.lint} note={notes.lint} onChange={(v) => edit('lint', v)} loading={aiBusy} issues={issues.lint} />
                  <CmdRow icon={<TestTubeDiagonal size={17} />} title="Тесты" hint="Все тесты, без watch-режима" placeholder="не заданы" value={cmds.test} note={notes.test} onChange={(v) => edit('test', v)} loading={aiBusy} issues={issues.test} />
                  <CmdRow icon={<MonitorPlay size={17} />} title="Запуск приложения" hint="Для визуальной проверки; {port} — свободный порт" placeholder="например: npm run dev -- --port {port}" value={cmds.run} note={notes.run} onChange={(v) => edit('run', v)} loading={aiBusy} issues={issues.run} />
                  <CmdRow icon={<Globe size={17} />} title="Адрес" hint="Главная страница приложения" placeholder="http://localhost:{port}" value={cmds.url} note={notes.url} onChange={(v) => edit('url', v)} loading={aiBusy} />
                  <div className="cmd-row">
                    <span className="cmd-icon"><FileLock2 size={17} /></span>
                    <div className="cmd-label">
                      <strong>Файлы окружения</strong>
                      <span>Копируются в отдельную копию прогона, не коммитятся</span>
                    </div>
                    <div className="cmd-field">
                      <Input
                        mono
                        placeholder="например: apps/api/.env, apps/web/.env.local"
                        value={envFiles}
                        onChange={(e) => {
                          setEnvFiles(e.target.value);
                          if (saved === 'saved') setSaved('dirty');
                        }}
                      />
                      <span className="cmd-note">{project?.envFiles.length ? `Найдены в проекте: ${project.envFiles.join(', ')}` : 'В git их нет, поэтому в worktree без копирования их не будет. В режиме «Ветка» не нужны.'}</span>
                    </div>
                  </div>
                  <div className={`cmd-row ${aiBusy ? 'is-loading' : ''}`}>
                    <span className="cmd-icon"><KeyRound size={17} /></span>
                    <div className="cmd-label">
                      <strong>Инструкция для проверки</strong>
                      <span>Тестовый вход, сид данных — для визуальной проверки</span>
                    </div>
                    <div className="cmd-field">
                      <TextArea
                        rows={3}
                        placeholder={'например: вход test@example.com / test1234 (создаётся npm run seed в apps/api), доска — /board'}
                        value={visualNotes}
                        onChange={(e) => {
                          setVisualNotes(e.target.value);
                          if (saved === 'saved') setSaved('dirty');
                        }}
                      />
                      <span className="cmd-note">Только тестовые учётки — текст хранится в данных приложения и передаётся агенту как есть.</span>
                    </div>
                  </div>
                </div>
                <div className="cmd-actions">
                  <p className="cmd-foot">Нейросеть только читает файлы проекта — package.json, конфиги, CI — и ничего не меняет.</p>
                  <span className="grow" />
                  {saved === 'saved' ? <span className="cmd-saved"><Check size={14} /> Сохранено для проекта</span> : (
                    <Button tone="ghost" busy={saving} onClick={() => void saveCommands()}>Сохранить для проекта</Button>
                  )}
                </div>
              </section>
              </>
            )}
          </div>

          {tab !== 'knowledge' && (
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
                          {project?.isRepo ? <button className="link" onClick={() => setTab('commands')}>задайте в «Командах проекта»</button> : 'задайте в «Командах проекта»'}
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
                    <button
                      key={w.id}
                      role="radio"
                      aria-checked={workspace === w.id}
                      className={workspace === w.id ? 'is-on' : ''}
                      onClick={() => {
                        setWorkspace(w.id);
                        if (saved === 'saved') setSaved('dirty');
                      }}
                    >
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
          )}
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

const WORKSPACES: { id: Workspace; title: string; hint: ReactNode }[] = [
  {
    id: 'worktree',
    title: 'Worktree',
    hint: <>Отдельная копия проекта — ваша рабочая копия не меняется. Результат — коммит в ветке <code>psflow/&lt;id&gt;</code>, влить можно кнопкой в конце прогона.</>,
  },
  {
    id: 'branch',
    title: 'Ветка',
    hint: <>Работа прямо в проекте на новой ветке <code>psflow/&lt;id&gt;</code> — изменения сразу видны в редакторе. Нужна чистая рабочая копия; подготовка не запускается, зависимости — ваши.</>,
  },
];

function CmdRow({ icon, title, hint, placeholder, value, note, onChange, loading, issues }: {
  icon: ReactNode; title: string; hint: string; placeholder: string; value: string; note: string; onChange: (v: string) => void; loading: boolean; issues?: CommandIssue[];
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
        {issues?.length ? issues.map((x, i) => (
          <span key={i} className="cmd-issue">
            <TriangleAlert size={13} /> {x.message}
            {x.fix && <button className="link" onClick={() => onChange(x.fix!)}>Исправить</button>}
          </span>
        )) : note && <span className="cmd-note" title={note}>{note}</span>}
      </div>
    </div>
  );
}

const DOC_ICON: [RegExp, ReactNode][] = [
  [/стек/i, <Layers key="i" size={16} />],
  [/структур/i, <FolderTree key="i" size={16} />],
  [/устроен|архитект/i, <Workflow key="i" size={16} />],
  [/соглашен|стиль/i, <BookText key="i" size={16} />],
  [/тест/i, <FlaskConical key="i" size={16} />],
  [/запуск|окружен/i, <Play key="i" size={16} />],
];

/** Профиль по разделам «## Заголовок» — каждый раздел отдельной карточкой; без разделов — одна карточка. */
function splitProfile(md: string): { title: string; body: string }[] {
  const parts = md.split(/^##\s+/m).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 && !/^##\s/m.test(md)) return md.trim() ? [{ title: 'Профиль', body: md.trim() }] : [];
  return parts.map((p) => {
    const nl = p.indexOf('\n');
    return nl < 0 ? { title: p, body: '' } : { title: p.slice(0, nl).trim(), body: p.slice(nl + 1).trim() };
  });
}

/** Вкладка «Знания о проекте»: профиль набором документов и уроки прошлых прогонов. */
function KnowledgeView({ repo, name }: { repo: string; name: string }) {
  const [k, setK] = useState<ProjectKnowledge | null>(null);
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState('');
  const [busy, setBusy] = useState<'save' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.psflow.core.getKnowledge(repo).then((x) => {
      if (!alive) return;
      setK(x);
      setProfile(x.profile ?? '');
      setEditing(false);
    });
    return () => {
      alive = false;
    };
  }, [repo]);
  const run = async (kind: 'save' | 'refresh', fn: () => Promise<ProjectKnowledge>) => {
    setBusy(kind);
    setError(null);
    try {
      const x = await fn();
      setK(x);
      setProfile(x.profile ?? '');
      setEditing(false);
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };
  if (!k) return <div className="center"><span className="spinner big" /></div>;
  const docs = splitProfile(k.profile ?? '');
  const lessons = k.lessons ?? [];
  const removeLesson = (i: number) => void run('save', () => window.psflow.core.saveKnowledge(repo, { ...k, lessons: lessons.filter((_, j) => j !== i) }));
  return (
    <div className="knowledge-view">
      <section className="panel knowledge-intro">
        <header className="panel-head">
          <div>
            <h2>Знания о проекте {name}</h2>
            <p>Получают все агенты — чтобы не изучать проект с нуля в каждом прогоне. Профиль собирается сам перед первым планом, уроки добавляются после прогонов: из ваших правок, замечаний ревью и сбоев проверок.</p>
          </div>
          <div className="knowledge-actions">
            {k.profile && !editing && <Button tone="quiet" icon={<PencilLine size={15} />} onClick={() => setEditing(true)}>Редактировать</Button>}
            <Button tone="ghost" icon={<Sparkles size={15} />} busy={busy === 'refresh'} disabled={busy !== null} onClick={() => void run('refresh', () => window.psflow.core.refreshProfile(repo))}>
              {busy === 'refresh' ? 'Изучаю проект…' : k.profile ? 'Пересобрать профиль' : 'Изучить проект'}
            </Button>
          </div>
        </header>
        {k.profileAt && <p className="muted knowledge-date">Профиль собран {new Date(k.profileAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · уроков: {lessons.length}</p>}
        {error && <p className="inline-error">{error}</p>}
      </section>

      {editing ? (
        <section className="panel">
          <TextArea rows={22} className="mono knowledge-profile" value={profile} onChange={(e) => setProfile(e.target.value)} />
          <div className="cmd-actions">
            <p className="cmd-foot">Разделы — заголовками «## Стек», «## Структура»… — каждый станет отдельной карточкой.</p>
            <span className="grow" />
            <Button tone="quiet" onClick={() => { setProfile(k.profile ?? ''); setEditing(false); }}>Отмена</Button>
            <Button tone="primary" busy={busy === 'save'} onClick={() => void run('save', () => window.psflow.core.saveKnowledge(repo, { ...k, profile }))}>Сохранить</Button>
          </div>
        </section>
      ) : docs.length ? (
        <div className="doc-grid">
          {docs.map((d, i) => (
            <article key={d.title + i} className="kdoc" style={{ animationDelay: `${i * 0.04}s` }}>
              <header>
                <span className="kdoc-icon">{DOC_ICON.find(([re]) => re.test(d.title))?.[1] ?? <FileText size={16} />}</span>
                <strong>{d.title}</strong>
              </header>
              <Markdown source={d.body} className="kdoc-md" />
            </article>
          ))}
        </div>
      ) : (
        <section className="panel knowledge-empty-card">
          <span className="browser-empty-icon"><Sparkles size={22} /></span>
          <strong>Профиль ещё не собран</strong>
          <p>Соберётся сам перед первым планом в этом проекте — или нажмите «Изучить проект».</p>
        </section>
      )}

      <article className="kdoc kdoc-lessons">
        <header>
          <span className="kdoc-icon"><Lightbulb size={16} /></span>
          <strong>Уроки прошлых прогонов</strong>
          <span className="muted">{lessons.length || ''}</span>
        </header>
        {lessons.length ? (
          <ul className="lessons">
            {[...lessons].reverse().map((l, ri) => {
              const i = lessons.length - 1 - ri;
              return (
                <li key={`${l.at}-${i}`}>
                  <span>{l.text}</span>
                  <time className="muted">{new Date(l.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</time>
                  <button className="lesson-del" title="Удалить урок" onClick={() => removeLesson(i)}><X size={14} /></button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted knowledge-empty">Появятся после прогонов, где были ваши правки, замечания ревью или упавшие проверки.</p>
        )}
      </article>
    </div>
  );
}
