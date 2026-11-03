// Общее для экранов проектов и «Новой задачи»: загрузка и сохранение команд проекта, выбор проекта, режимы работы.
import type { ProjectCommands, ProjectConfig, ProjectListItem, RelatedRepo, Workspace } from '@purpleflow/core';
import { Check, ChevronDown, FolderGit2, FolderOpen, Minus, Plus, Settings2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { shortPath } from '../../lib/format';
import { useActions } from '../../lib/store';
import { bridge } from '../../lib/api';

export type ProjectInfo = ProjectCommands & { envFiles: string[]; isRepo: boolean; name: string; path: string };
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
}
export const projectName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export async function loadProject(dir: string): Promise<LoadedProject> {
  const det = await bridge.core.detectProject(dir);
  const info = { ...det, path: dir };
  const cfg = det.isRepo ? await bridge.core.getProjectConfig(dir).catch(() => null) : null;
  if (cfg) {
    return {
      info,
      cfg,
      cmds: { setup: cfg.setupCommand, lint: cfg.lintCommand, test: cfg.testCommand, run: cfg.runCommand ?? '', url: cfg.appUrl ?? '' },
      notes: { ...cfg.notes, run: cfg.notes.run ?? '', url: '' },
      workspace: cfg.workspace ?? 'worktree',
      visualNotes: cfg.visualNotes ?? '',
      envFiles: cfg.envFiles ?? det.envFiles,
      quickTest: cfg.quickTestCommand ?? '',
      prepare: cfg.prepareCommand ?? '',
      related: cfg.relatedRepos ?? [],
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
  p: Pick<LoadedProject, 'cmds' | 'notes' | 'workspace' | 'visualNotes' | 'envFiles' | 'quickTest' | 'prepare' | 'related'> & {
    path: string;
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
    workspace: p.workspace,
    notes: { setup: p.notes.setup, lint: p.notes.lint, test: p.notes.test, run: p.notes.run },
  });
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
                      <strong>{projectName(p.path)}</strong>
                      <span className="mono">{shortPath(p.path)}</span>
                    </span>
                    {p.path === project?.path && <Check size={15} className="ok" />}
                  </button>
                ))}
              </div>
            )}
            <button role="menuitem" className="project-menu-item is-new" onClick={async () => pick(await bridge.pickFolder())}>
              <Plus size={15} />
              <span>Новый проект — выбрать папку…</span>
            </button>
          </div>
        </>
      )}
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
