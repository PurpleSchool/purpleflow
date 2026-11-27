// Общее для экранов проектов и «Новой задачи»: загрузка и сохранение команд проекта, выбор проекта, режимы работы.
import type { DetectedProject, ForgeRef, MultiRepo, ProjectConfig, ProjectListItem, RelatedRepo, Workspace } from '@purpleflow/core';
import { Check, ChevronDown, FolderGit2, FolderOpen, Minus, Plus, Settings2, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { shortPath } from '../../lib/format';
import { useActions } from '../../lib/store';
import { bridge, cleanErr } from '../../lib/api';
import { Button } from '../../components/ui';

/** repoRoot — папка лежит внутри другого репозитория и сама проектом не считается; nested — репозитории внутри папки. */
export type ProjectInfo = DetectedProject & { path: string };
export type Cmd = 'setup' | 'lint' | 'test' | 'run' | 'url';
export type Cmds = Record<Cmd, string>;
/** Проект с командами: сохранёнными или найденными по файлам проекта (черновик). */
export interface LoadedProject {
  info: ProjectInfo;
  cfg: ProjectConfig | null;
  cmds: Cmds;
  notes: Cmds;
  workspace: Workspace;
  visualNotes: string;
  envFiles: string[];
  /** Быстрые тесты для промежуточных кругов; пусто — всегда полный набор. */
  quickTest?: string;
  /** Подготовка перед каждым запуском приложения: миграции, сиды. */
  prepare?: string;
  /** Соседние репозитории — агенты читают, но не меняют. */
  related?: RelatedRepo[];
  /** Проект из нескольких репозиториев: верхняя папка и участники (этот репозиторий — основной). */
  multi?: MultiRepo;
  /** Сохранённый провайдер PR/MR; пусто — определяется по origin. */
  forge?: ForgeRef | null;
  /** Хук pre-commit репозитория — проверкой на стадии «Проверки»; по умолчанию включено. */
  gitHooks?: boolean;
}
export const projectName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/** Имя проекта в списках: у проекта из нескольких репозиториев — его верхняя папка. */
export const listName = (p: Pick<ProjectListItem, 'path' | 'root'>) => projectName(p.root ?? p.path);
export async function loadProject(dir: string): Promise<LoadedProject> {
  const det = await bridge.core.detectProject(dir);
  // Верхняя папка уже собрана в проект — открываем его (он записан на основной репозиторий).
  if (det.projectOf && det.projectOf !== dir) return loadProject(det.projectOf);
  const cfg = det.isRepo ? await bridge.core.getProjectConfig(dir).catch(() => null) : null;
  const multi = cfg?.multiRepo?.repos.length ? cfg.multiRepo : undefined;
  const info = { ...det, path: dir, name: multi ? projectName(multi.root) : det.name };
  if (cfg) {
    return {
      info,
      multi,
      cfg,
      cmds: { setup: cfg.setupCommand, lint: cfg.lintCommand, test: cfg.testCommand, run: cfg.runCommand ?? '', url: cfg.appUrl ?? '' },
      notes: { ...cfg.notes, run: cfg.notes.run ?? '', url: '' },
      workspace: cfg.workspace ?? 'worktree',
      visualNotes: cfg.visualNotes ?? '',
      envFiles: cfg.envFiles ?? det.envFiles,
      quickTest: cfg.quickTestCommand ?? '',
      prepare: cfg.prepareCommand ?? '',
      related: cfg.relatedRepos ?? [],
      forge: cfg.forge ?? null,
      gitHooks: cfg.gitHooks !== false,
    };
  }
  const from = det.detectedFrom ? `по ${det.detectedFrom}` : '';
  return {
    info,
    cfg: null,
    cmds: { setup: det.setupCommand, lint: det.lintCommand, test: det.testCommand, run: '', url: '' },
    notes: { setup: det.setupCommand ? from : '', lint: det.lintCommand ? from : '', test: det.testCommand ? from : '', run: '', url: '' },
    workspace: 'worktree',
    visualNotes: '',
    envFiles: det.envFiles,
  };
}
export function saveLoaded(
  p: Pick<LoadedProject, 'cmds' | 'notes' | 'workspace' | 'visualNotes' | 'envFiles' | 'quickTest' | 'prepare' | 'related' | 'gitHooks'> & {
    path: string;
    /** Не передан — участники проекта остаются прежними; null — проект снова из одного репозитория. */
    multi?: MultiRepo | null;
    /** undefined — не менять сохранённый провайдер, null — сбросить к автоопределению. */
    forge?: ForgeRef | null;
  },
) {
  return bridge.core.saveProjectConfig(p.path, {
    setupCommand: p.cmds.setup,
    lintCommand: p.cmds.lint,
    testCommand: p.cmds.test,
    quickTestCommand: p.quickTest,
    prepareCommand: p.prepare,
    runCommand: p.cmds.run,
    appUrl: p.cmds.url,
    visualNotes: p.visualNotes,
    envFiles: p.envFiles,
    relatedRepos: p.related,
    forge: p.forge,
    workspace: p.workspace,
    gitHooks: p.gitHooks !== false,
    notes: { setup: p.notes.setup, lint: p.notes.lint, test: p.notes.test, run: p.notes.run },
    ...(p.multi !== undefined ? { multiRepo: p.multi } : {}),
  });
}

/** Команда, записанная для одного репозитория, — из верхней папки: сначала cd в основной. */
export const fromRoot = (main: string, c: string) => (c.trim() && !/^\s*cd\s/.test(c) ? `cd ${main} && ${c.trim()}` : c);

/**
 * Собрать проект из нескольких репозиториев: он записывается на основной; команды основного (сохранённые или найденные)
 * переводятся на запуск из верхней папки. Возвращает путь основного — его и открываем.
 */
export async function createMultiProject(root: string, main: string, repos: string[]): Promise<string> {
  const mainPath = `${root.replace(/[\\/]+$/, '')}/${main}`;
  const x = await loadProject(mainPath);
  const run = (c: string) => fromRoot(main, c);
  await saveLoaded({
    ...x,
    path: mainPath,
    cmds: x.multi ? x.cmds : { ...x.cmds, setup: run(x.cmds.setup), lint: run(x.cmds.lint), test: run(x.cmds.test), run: run(x.cmds.run) },
    workspace: 'worktree',
    multi: { root, repos: repos.filter((r) => r !== main) },
  });
  return mainPath;
}

/** Выбор репозиториев проекта: галочка — участвует, переключатель — основной (в нём план и история). */
export function RepoChecklist({
  repos,
  on,
  main,
  onToggle,
  onMain,
}: {
  repos: string[];
  on: string[];
  main: string;
  onToggle: (rel: string) => void;
  onMain?: (rel: string) => void;
}) {
  return (
    <div className="repo-list" role="group" aria-label="Репозитории проекта">
      {repos.map((rel) => {
        const checked = rel === main || on.includes(rel);
        return (
          <div key={rel} className={`repo-row ${checked ? 'is-on' : ''}`}>
            <label className="repo-check">
              <input
                type="checkbox"
                checked={checked}
                disabled={rel === main}
                onChange={() => onToggle(rel)}
                aria-label={`Участвует: ${rel}`}
              />
              <FolderGit2 size={15} />
              <span className="mono">{rel}</span>
            </label>
            {rel === main ? (
              <span className="repo-main">основной</span>
            ) : (
              onMain &&
              checked && (
                <button type="button" className="link repo-make-main" onClick={() => onMain(rel)}>
                  сделать основным
                </button>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Папка не репозиторий, но в ней есть репозитории: отметить участников и основной — и проект готов. */
function MultiRepoSetup({ project, onCreated }: { project: ProjectInfo; onCreated: (dir: string) => void }) {
  const repos = project.nested ?? [];
  const [on, setOn] = useState<string[]>(repos);
  const [main, setMain] = useState(repos[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = on.filter((r) => r !== main);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await createMultiProject(project.path, main, picked));
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="multi-setup">
      <strong>
        В папке {repos.length} {plural(repos.length, 'репозиторий', 'репозитория', 'репозиториев')} — соберите из них проект
      </strong>
      <p>
        Агент будет работать во всех отмеченных сразу: правки, проверки и ревью — по всем, коммит и слияние — в каждом. В основном
        репозитории лежат план OpenSpec и история проекта. Неотмеченные агент только читает.
      </p>
      <RepoChecklist
        repos={repos}
        on={on}
        main={main}
        onToggle={(rel) => setOn(on.includes(rel) ? on.filter((r) => r !== rel) : [...on, rel])}
        onMain={setMain}
      />
      {error && <p className="inline-error">{error}</p>}
      <div className="multi-setup-foot">
        <Button tone="primary" busy={busy} disabled={!main || !picked.length} onClick={() => void create()}>
          Создать проект из {picked.length + 1} {plural(picked.length + 1, 'репозитория', 'репозиториев', 'репозиториев')}
        </Button>
        {!picked.length && (
          <span className="muted">Отметьте хотя бы два репозитория — или выберите один репозиторий как обычный проект.</span>
        )}
      </div>
    </div>
  );
}
/** Сводка команд галочками: что настроено, что пропускается. */
export function cmdSummary(cmds: Cmds) {
  return [
    { label: 'Подготовка', value: cmds.setup },
    { label: 'Линтер', value: cmds.lint },
    { label: 'Тесты', value: cmds.test },
    { label: 'Запуск', value: cmds.run && cmds.url ? `${cmds.run}  →  ${cmds.url}` : '' },
  ].map((c) => ({ ...c, on: Boolean(c.value.trim()) }));
}
export function CmdChips({ cmds }: { cmds: Cmds }) {
  return (
    <>
      {cmdSummary(cmds).map((c) => (
        <span key={c.label} className={`cmd-chip ${c.on ? 'is-on' : ''}`} title={c.on ? c.value : 'Не задано — шаг пропускается'}>
          {c.on ? <Check size={13} /> : <Minus size={13} />}
          {c.label}
        </span>
      ))}
    </>
  );
}
export const WORKSPACES: { id: Workspace; title: string; hint: ReactNode }[] = [
  {
    id: 'worktree',
    title: 'Worktree',
    hint: (
      <>
        Отдельная копия проекта — ваша рабочая копия не меняется. Результат — коммит в ветке <code>purpleflow/&lt;id&gt;</code>, влить можно
        кнопкой в конце прогона.
      </>
    ),
  },
  {
    id: 'branch',
    title: 'Ветка',
    hint: (
      <>
        Работа прямо в проекте на новой ветке <code>purpleflow/&lt;id&gt;</code> — изменения сразу видны в редакторе. Нужна чистая рабочая
        копия; подготовка не запускается, зависимости — ваши.
      </>
    ),
  },
];
/** Выбор проекта в шапке: недавние проекты и «Новый проект» (выбор папки), рядом — переход в настройки проекта. */
export function ProjectPicker({ project, draft, onPick }: { project: ProjectInfo | null; draft: boolean; onPick: (dir: string) => void }) {
  const { go } = useActions();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ProjectListItem[]>([]);
  useEffect(() => {
    if (open)
      void bridge.core
        .listProjects()
        .then((l) => setList(l.filter((p) => p.exists)))
        .catch(() => setList([]));
  }, [open]);
  const pick = (dir: string | null) => {
    setOpen(false);
    if (dir) onPick(dir);
  };
  return (
    <div className="project-pick">
      <button
        className={`project is-compact ${project ? (project.isRepo ? 'is-ok' : 'is-bad') : ''}`}
        title={project?.path}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
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
              <strong>Выберите проект</strong>
              <span>или откройте новый</span>
            </>
          )}
        </span>
        <ChevronDown size={16} className="project-chevron" />
      </button>
      {project?.isRepo && (
        <button
          className="project-settings"
          title={draft ? 'Настройки проекта — команды найдены по файлам, проверьте' : 'Настройки проекта'}
          onClick={() => go({ name: 'project', path: project.path, tab: draft ? 'commands' : 'overview' })}
        >
          <Settings2 size={18} />
          {draft && <span className="tab-dot" />}
        </button>
      )}
      {open && (
        <>
          <div className="pop-backdrop" onClick={() => setOpen(false)} />
          <div className="pop project-menu" role="menu">
            {list.length > 0 && (
              <div className="project-menu-list">
                {list.map((p) => (
                  <button
                    key={p.path}
                    role="menuitem"
                    className={`project-menu-item ${p.path === project?.path ? 'is-on' : ''}`}
                    onClick={() => pick(p.path)}
                  >
                    <FolderGit2 size={15} />
                    <span className="project-card-name">
                      <strong>{listName(p)}</strong>
                      <span className="mono">{shortPath(p.path)}</span>
                    </span>
                    {p.path === project?.path && <Check size={15} className="ok" />}
                  </button>
                ))}
              </div>
            )}
            <button
              role="menuitem"
              className="project-menu-item is-new"
              onClick={() => {
                setOpen(false);
                go({ name: 'addProject' });
              }}
            >
              <Plus size={15} />
              <span>Новый проект</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
/** Проект с нуля: git init, .gitignore и первый коммит одной кнопкой. onDone — папку перечитать. */
export function InitRepoButton({
  dir,
  label,
  tone = 'primary',
  onDone,
}: {
  dir: string;
  label: string;
  tone?: 'primary' | 'ghost';
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const init = async () => {
    setBusy(true);
    setError('');
    try {
      await bridge.core.initRepo(dir);
      onDone();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button tone={tone} icon={<FolderGit2 size={15} />} busy={busy} onClick={() => void init()}>
        {label}
      </Button>
      {error && <span className="inline-error">{error}</span>}
    </>
  );
}

/** Почему папка не годится под проект: не репозиторий или подпапка чужого — тогда предлагаем его корень или свой репозиторий. */
export function NotRepoNote({ project, onRoot }: { project: ProjectInfo; onRoot: (dir: string) => void }) {
  if (project.isRepo) return null;
  if (project.nested?.length && !project.repoRoot) return <MultiRepoSetup key={project.path} project={project} onCreated={onRoot} />;
  const reload = () => onRoot(project.path);
  if (project.repoRoot)
    return (
      <div className="init-note">
        <p className="inline-error">
          <TriangleAlert size={14} /> Папка лежит внутри репозитория <code>{shortPath(project.repoRoot)}</code> — задача ушла бы в него.{' '}
          <button className="link" onClick={() => onRoot(project.repoRoot!)}>
            Возьмите корень репозитория
          </button>{' '}
          или сделайте папку отдельным репозиторием.
        </p>
        <InitRepoButton dir={project.path} tone="ghost" label="Сделать отдельным репозиторием" onDone={reload} />
      </div>
    );
  return (
    <div className="init-note">
      <p className="init-note-text">
        {project.empty
          ? 'В репозитории ещё нет коммитов — прогонам не от чего начать ветку.'
          : 'Папка ещё не git-репозиторий. Начнём проект с нуля: создадим репозиторий с веткой main, .gitignore без зависимостей и секретов и первый коммит с тем, что уже есть в папке.'}
      </p>
      <InitRepoButton dir={project.path} label={project.empty ? 'Сделать первый коммит' : 'Создать репозиторий'} onDone={reload} />
    </div>
  );
}
export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
