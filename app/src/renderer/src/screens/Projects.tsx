import { useEffect, useState, type ReactNode } from 'react';
import {
  BookText, Check, ChevronDown, Settings2, FileLock2, FileText, FlaskConical, FolderGit2, FolderOpen, FolderTree, GitBranch, GitPullRequest, Globe, KeyRound, Layers,
  DatabaseZap, Lightbulb, Minus, MonitorPlay, PackageOpen, PencilLine, Play, Plus, ScanSearch, Sparkles, TestTubeDiagonal, TriangleAlert, Stethoscope, Workflow, X, Zap,
} from 'lucide-react';
import type { CommandIssue, EnvCheck, ProjectCommands, ProjectConfig, ProjectKnowledge, ProjectListItem, ProjectOverview, ProjectStats, Workspace } from '@psflow/core';
import { Button, Input, TextArea, Topbar } from '../components/ui';
import { PillTabs } from '../components/PillTabs';
import { Markdown } from '../components/Markdown';
import { useStore, type ProjectTab } from '../lib/store';
import { MODES, stageTitle } from '../lib/stages';
import { shortPath, tokens, when } from '../lib/format';

export type ProjectInfo = ProjectCommands & { envFiles: string[]; isRepo: boolean; name: string; path: string };
export type Cmd = 'setup' | 'lint' | 'test' | 'run' | 'url';
type Cmds = Record<Cmd, string>;

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
}

export const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export const projectName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export async function loadProject(dir: string): Promise<LoadedProject> {
  const det = await window.psflow.core.detectProject(dir);
  const info = { ...det, path: dir };
  const cfg = det.isRepo ? await window.psflow.core.getProjectConfig(dir).catch(() => null) : null;
  if (cfg) {
    return {
      info, cfg,
      cmds: { setup: cfg.setupCommand, lint: cfg.lintCommand, test: cfg.testCommand, run: cfg.runCommand ?? '', url: cfg.appUrl ?? '' },
      notes: { ...cfg.notes, run: cfg.notes.run ?? '', url: '' },
      workspace: cfg.workspace ?? 'worktree',
      visualNotes: cfg.visualNotes ?? '',
      envFiles: cfg.envFiles ?? det.envFiles,
      quickTest: cfg.quickTestCommand ?? '',
      prepare: cfg.prepareCommand ?? '',
    };
  }
  const from = det.detectedFrom ? `по ${det.detectedFrom}` : '';
  return {
    info, cfg: null,
    cmds: { setup: det.setupCommand, lint: det.lintCommand, test: det.testCommand, run: '', url: '' },
    notes: { setup: det.setupCommand ? from : '', lint: det.lintCommand ? from : '', test: det.testCommand ? from : '', run: '', url: '' },
    workspace: 'worktree',
    visualNotes: '',
    envFiles: det.envFiles,
  };
}

export function saveLoaded(p: Pick<LoadedProject, 'cmds' | 'notes' | 'workspace' | 'visualNotes' | 'envFiles' | 'quickTest' | 'prepare'> & { path: string }) {
  return window.psflow.core.saveProjectConfig(p.path, {
    setupCommand: p.cmds.setup, lintCommand: p.cmds.lint, testCommand: p.cmds.test, quickTestCommand: p.quickTest, prepareCommand: p.prepare, runCommand: p.cmds.run, appUrl: p.cmds.url,
    visualNotes: p.visualNotes, envFiles: p.envFiles, workspace: p.workspace,
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
    hint: <>Отдельная копия проекта — ваша рабочая копия не меняется. Результат — коммит в ветке <code>psflow/&lt;id&gt;</code>, влить можно кнопкой в конце прогона.</>,
  },
  {
    id: 'branch',
    title: 'Ветка',
    hint: <>Работа прямо в проекте на новой ветке <code>psflow/&lt;id&gt;</code> — изменения сразу видны в редакторе. Нужна чистая рабочая копия; подготовка не запускается, зависимости — ваши.</>,
  },
];

/** Выбор проекта в шапке: недавние проекты и «Новый проект» (выбор папки), рядом — переход в настройки проекта. */
export function ProjectPicker({ project, draft, onPick }: { project: ProjectInfo | null; draft: boolean; onPick: (dir: string) => void }) {
  const { go } = useStore();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ProjectListItem[]>([]);
  useEffect(() => {
    if (open) void window.psflow.core.listProjects().then((l) => setList(l.filter((p) => p.exists))).catch(() => setList([]));
  }, [open]);
  const pick = (dir: string | null) => {
    setOpen(false);
    if (dir) onPick(dir);
  };
  return (
    <div className="project-pick">
      <button className={`project is-compact ${project ? (project.isRepo ? 'is-ok' : 'is-bad') : ''}`} title={project?.path} onClick={() => setOpen(!open)} aria-expanded={open}>
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
        <button className="project-settings" title={draft ? 'Настройки проекта — команды найдены по файлам, проверьте' : 'Настройки проекта'} onClick={() => go({ name: 'project', path: project.path, tab: draft ? 'commands' : 'overview' })}>
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
                  <button key={p.path} role="menuitem" className={`project-menu-item ${p.path === project?.path ? 'is-on' : ''}`} onClick={() => pick(p.path)}>
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
            <button role="menuitem" className="project-menu-item is-new" onClick={async () => pick(await window.psflow.pickFolder())}>
              <Plus size={15} />
              <span>Новый проект — выбрать папку…</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ——— Список проектов ———

export function ProjectsScreen() {
  const { go, state } = useStore();
  const [list, setList] = useState<ProjectListItem[] | null>(null);
  useEffect(() => {
    void window.psflow.core.listProjects().then(setList).catch(() => setList([]));
  }, [state.runs]);

  const open = async () => {
    const dir = await window.psflow.pickFolder();
    if (!dir) return;
    const known = list?.find((p) => p.path === dir);
    go({ name: 'project', path: dir, tab: known?.configured ? 'overview' : 'commands' });
  };

  return (
    <div className="screen">
      <Topbar title="Проекты" sub="Команды, окружение и знания каждого проекта — настраиваются один раз и подставляются в задачи">
        <Button tone="primary" icon={<FolderOpen size={15} />} onClick={() => void open()}>Открыть папку…</Button>
      </Topbar>
      <div className="scroll">
        <div className="projects-page">
          {!list ? (
            <div className="center"><span className="spinner big" /></div>
          ) : list.length === 0 ? (
            <section className="panel knowledge-empty-card">
              <span className="browser-empty-icon"><FolderGit2 size={22} /></span>
              <strong>Проектов пока нет</strong>
              <p>Откройте папку git-репозитория — приложение найдёт команды проекта и соберёт знания о нём.</p>
              <Button tone="primary" icon={<FolderOpen size={15} />} onClick={() => void open()}>Открыть папку…</Button>
            </section>
          ) : (
            <div className="project-grid">
              {list.map((p, i) => (
                <button key={p.path} className={`project-card ${p.exists ? '' : 'is-missing'}`} style={{ animationDelay: `${i * 0.03}s` }} onClick={() => go({ name: 'project', path: p.path })}>
                  <span className="project-card-head">
                    <span className="kdoc-icon"><FolderGit2 size={16} /></span>
                    <span className="project-card-name">
                      <strong>{projectName(p.path)}</strong>
                      <span className="mono">{shortPath(p.path)}</span>
                    </span>
                    {p.active > 0 && <span className="project-live"><i />{p.active === 1 ? 'идёт прогон' : `прогонов: ${p.active}`}</span>}
                  </span>
                  <span className="project-card-meta">
                    {!p.exists ? <span className="tag is-bad">Папка не найдена</span> : !p.configured && <span className="tag is-wait">Не настроен</span>}
                    <span>{p.runs ? `${p.runs} ${plural(p.runs, 'прогон', 'прогона', 'прогонов')}` : 'Прогонов не было'}</span>
                    {p.lastRunAt && <span>последний {when(p.lastRunAt)}</span>}
                  </span>
                </button>
              ))}
              <button className="project-card is-add" onClick={() => void open()}>
                <Plus size={18} />
                <span>Открыть папку…</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ——— Страница проекта ———

export function ProjectScreen({ path, initialTab }: { path: string; initialTab?: ProjectTab }) {
  const { go } = useStore();
  const [tab, setTab] = useState<ProjectTab>(initialTab ?? 'overview');
  const [p, setP] = useState<LoadedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const reload = () => loadProject(path).then(setP).catch((e) => setError(cleanErr(e)));
  useEffect(() => {
    void reload();
  }, [path]);

  const repo = p?.info.isRepo;
  return (
    <div className="screen">
      <Topbar title={p?.info.name ?? projectName(path)} sub={<span className="mono topbar-path" title={path}>{shortPath(path)}</span>}>
        <Button tone="primary" icon={<Plus size={15} />} disabled={!repo} onClick={() => go({ name: 'new', project: path })}>Новая задача</Button>
      </Topbar>
      <div className="page-tabs">
        <PillTabs<ProjectTab>
          className="tabs"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'overview', label: 'Обзор' },
            { id: 'commands', label: 'Команды и окружение', disabled: !repo, extra: repo && (!p?.cfg || dirty) ? <span className="tab-dot" title="Не сохранены" /> : undefined },
            { id: 'knowledge', label: 'Знания о проекте', disabled: !repo },
          ]}
        />
      </div>
      <div className="scroll">
        <div className="project-page step-enter" key={tab}>
          {error && <p className="inline-error"><TriangleAlert size={14} /> {error}</p>}
          {!p ? (
            !error && <div className="center"><span className="spinner big" /></div>
          ) : tab === 'overview' || !repo ? (
            <Overview p={p} onTab={setTab} />
          ) : tab === 'commands' ? (
            <CommandsPanel p={p} onSaved={() => void reload()} onDirty={setDirty} />
          ) : (
            <KnowledgeView repo={p.info.path} name={p.info.name} />
          )}
        </div>
      </div>
    </div>
  );
}

function Overview({ p, onTab }: { p: LoadedProject; onTab: (t: ProjectTab) => void }) {
  const { state, go } = useStore();
  const [o, setO] = useState<ProjectOverview | null>(null);
  const [k, setK] = useState<ProjectKnowledge | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const repo = p.info.path;
  useEffect(() => {
    if (!p.info.isRepo) return;
    void window.psflow.core.projectOverview(repo).then(setO).catch(() => {});
    void window.psflow.core.getKnowledge(repo).then(setK).catch(() => {});
  }, [repo, p.info.isRepo]);
  const runs = state.runs.filter((r) => r.projectPath === repo);
  const sections = (k?.profile?.match(/^##\s/gm) ?? []).length;

  if (!p.info.isRepo) {
    return (
      <section className="panel knowledge-empty-card">
        <span className="browser-empty-icon"><TriangleAlert size={22} /></span>
        <strong>Это не git-репозиторий</strong>
        <p>Выполните <code>git init</code> и первый коммит — прогоны работают в отдельных ветках.</p>
      </section>
    );
  }

  return (
    <>
      <div className="overview-grid">
        <section className="panel overview-card">
          <h3>Репозиторий</h3>
          <dl className="facts">
            <dt>Папка</dt>
            <dd><span className="mono">{shortPath(repo)}</span><button className="link" onClick={() => void window.psflow.openPath(repo)}>Открыть</button></dd>
            <dt>Ветка</dt>
            <dd>{o ? <><GitBranch size={13} /> <span className="mono">{o.branch ?? '—'}</span><span className="muted">{o.dirty ? ` · изменённых файлов: ${o.dirty}` : ' · без изменений'}</span></> : <span className="muted">…</span>}</dd>
            <dt>origin</dt>
            <dd>{o ? (o.remote ? <span className="mono">{o.remote.replace(/^https?:\/\/|\.git$/g, '').replace(/^git@([^:]+):/, '$1/')}</span> : <span className="muted">не задан</span>) : <span className="muted">…</span>}</dd>
            <dt>Pull Request</dt>
            <dd>{o ? (o.prReady ? <span className="muted">{o.prReady}</span> : <><GitPullRequest size={13} className="ok" /> можно создавать через gh</>) : <span className="muted">…</span>}</dd>
          </dl>
        </section>

        <section className="panel overview-card">
          <h3>Настройка</h3>
          <button className="overview-row" onClick={() => onTab('commands')}>
            <span className="overview-row-head">
              <strong>Команды и окружение</strong>
              {!p.cfg && <span className="tag is-wait">не сохранены</span>}
            </span>
            <span className="overview-chips"><CmdChips cmds={p.cmds} /></span>
          </button>
          <button className="overview-row" onClick={() => onTab('knowledge')}>
            <span className="overview-row-head"><strong>Знания о проекте</strong></span>
            <span className="muted">
              {!k ? '…' : k.profile ? `Профиль: ${sections || 1} ${plural(sections || 1, 'раздел', 'раздела', 'разделов')}, собран ${k.profileAt ? when(k.profileAt) : ''} · уроков: ${k.lessons?.length ?? 0}` : 'Профиль ещё не собран — соберётся перед первым планом'}
            </span>
          </button>
        </section>
      </div>

      <StatsPanel repo={repo} runsKey={runs.map((r) => r.status + r.updatedAt).join()} />

      <section className="panel overview-runs">
        <header className="overview-runs-head">
          <h3>Прогоны</h3>
          <span className="muted">{runs.length || ''}</span>
        </header>
        {runs.length ? (
          <ul className="run-list">
            {runs.slice(0, 12).map((r) => (
              <li key={r.id}>
                <button className={`side-run st-${r.status}`} onClick={() => go({ name: 'run', runId: r.id })}>
                  <span className="side-dot" />
                  <span className="side-run-title">{r.title}</span>
                  <span className="run-list-mode">{MODES.find((m) => m.id === (r.mode ?? 'task'))?.title}</span>
                  <time className="muted">{when(r.createdAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Прогонов в этом проекте ещё не было.</p>
        )}
      </section>

      {p.cfg && (
        <div className="overview-forget">
          {forgetting ? (
            <>
              <span className="muted">Команды и знания проекта удалятся, прогоны останутся.</span>
              <Button tone="quiet" onClick={() => setForgetting(false)}>Отмена</Button>
              <Button tone="danger" onClick={() => void window.psflow.core.forgetProject(repo).then(() => go({ name: 'projects' }))}>Удалить настройки</Button>
            </>
          ) : (
            <Button tone="quiet" onClick={() => setForgetting(true)}>Удалить настройки проекта…</Button>
          )}
        </div>
      )}
    </>
  );
}

// ——— Статистика ———

function ms(n: number | null): string {
  if (n == null) return '—';
  const m = Math.round(n / 60_000);
  if (m < 1) return '< 1 мин';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
  return `${Math.floor(h / 24)} д${h % 24 ? ` ${h % 24} ч` : ''}`;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function StatsPanel({ repo, runsKey }: { repo: string; runsKey: string }) {
  const [s, setS] = useState<ProjectStats | null>(null);
  useEffect(() => {
    void window.psflow.core.projectStats(repo).then(setS).catch(() => setS(null));
  }, [repo, runsKey]);
  if (!s || s.total === 0) return null;

  const peak = Math.max(1, ...s.daily.map((d) => d.started));
  const returns = [
    { label: 'План вернули на доработку', n: s.returns.plan },
    { label: 'Замечания на приёмке', n: s.returns.acceptance },
    { label: 'Красные линтер или тесты', n: s.returns.tests },
    { label: 'Ревью нашло проблемы', n: s.returns.review },
    { label: 'Визуальная проверка нашла проблемы', n: s.returns.visual },
  ];
  const maxRet = Math.max(1, ...returns.map((r) => r.n));
  const time = s.agentMs + s.waitMs;
  const fmtDay = (d: string) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

  return (
    <section className="panel stats">
      <header className="overview-runs-head"><h3>Статистика</h3></header>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Прогонов</span>
          <strong>{s.total}</strong>
          <span className="kpi-sub">готово {s.finished}{s.active ? ` · идут ${s.active}` : ''}{s.stopped ? ` · остановлено ${s.stopped}` : ''}{s.cancelled ? ` · отменено ${s.cancelled}` : ''}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Приняты с первого раза</span>
          <strong>{s.finished ? `${pct(s.firstPass, s.finished)}%` : '—'}</strong>
          <span className="kpi-sub">{s.finished ? `${s.firstPass} из ${s.finished} без возврата плана и результата` : 'пока нет готовых'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">До готового коммита</span>
          <strong>{ms(s.medianLeadMs)}</strong>
          <span className="kpi-sub">медиана, вместе с ожиданием решений</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Попыток реализации</span>
          <strong>{s.avgImplAttempts == null ? '—' : s.avgImplAttempts.toFixed(1).replace('.', ',')}</strong>
          <span className="kpi-sub">в среднем на готовую задачу</span>
        </div>
      </div>

      <div className="activity">
        <div className="activity-head">
          <span className="kpi-label">Активность за 4 недели</span>
          <span className="activity-legend"><i className="is-started" />начато <i className="is-done" />готово</span>
        </div>
        <div className="activity-bars">
          {s.daily.map((d) => (
            <span key={d.day} className="activity-day" title={`${fmtDay(d.day)}: начато ${d.started}, готово ${d.finished}`}>
              <i className="is-started" style={{ height: `${(d.started / peak) * 100}%` }} />
              <i className="is-done" style={{ height: `${(Math.min(d.finished, peak) / peak) * 100}%` }} />
            </span>
          ))}
        </div>
        <div className="activity-axis"><span>{fmtDay(s.daily[0].day)}</span><span>сегодня</span></div>
      </div>

      <div className="stats-cols">
        <div className="stats-block">
          <span className="kpi-label">Возвраты</span>
          <ul className="hbars">
            {returns.map((r) => (
              <li key={r.label} className={r.n ? '' : 'is-zero'}>
                <span>{r.label}</span>
                <b>{r.n}</b>
                <i style={{ width: `${(r.n / maxRet) * 100}%` }} />
              </li>
            ))}
          </ul>
          {s.stops.length > 0 && (
            <p className="stats-note">Останавливались на: {s.stops.map((x) => `${stageTitle({ mode: undefined, visual: true }, x.stage)} — ${x.count}`).join(', ')}</p>
          )}
        </div>
        <div className="stats-block">
          <span className="kpi-label">Куда уходит время</span>
          {time > 0 ? (
            <>
              <div className="time-split">
                <i className="is-agent" style={{ width: `${pct(s.agentMs, time)}%` }} />
                <i className="is-wait" style={{ width: `${100 - pct(s.agentMs, time)}%` }} />
              </div>
              <div className="time-split-legend">
                <span><i className="is-agent" />Агенты работают · {ms(s.agentMs)}</span>
                <span><i className="is-wait" />Ждут вашего решения · {ms(s.waitMs)}</span>
              </div>
            </>
          ) : <p className="stats-note">Нет данных</p>}
          <span className="kpi-label stats-sub-head">По режимам</span>
          <div className="mode-stats">
            {s.byMode.map((m) => (
              <span key={m.mode} className="tag">{MODES.find((x) => x.id === m.mode)?.title ?? m.mode} · {m.total}{m.finished !== m.total ? ` (готово ${m.finished})` : ''}</span>
            ))}
          </div>
          <p className="stats-note">
            Токенов: {tokens(s.tokens)}{s.prs ? ` · PR: ${s.prs}` : ''}{s.merged ? ` · влито из приложения: ${s.merged}` : ''}
          </p>
        </div>
      </div>
    </section>
  );
}

// ——— Команды и окружение ———

function CommandsPanel({ p, onSaved, onDirty }: { p: LoadedProject; onSaved: () => void; onDirty: (d: boolean) => void }) {
  const repo = p.info.path;
  const [cmds, setCmds] = useState<Cmds>(p.cmds);
  const [notes, setNotes] = useState<Cmds>(p.notes);
  const [workspace, setWorkspace] = useState<Workspace>(p.workspace);
  const [visualNotes, setVisualNotes] = useState(p.visualNotes);
  const [quickTest, setQuickTest] = useState(p.quickTest ?? '');
  const [prepare, setPrepare] = useState(p.prepare ?? '');
  const [envFiles, setEnvFiles] = useState(p.envFiles.join(', '));
  const [saved, setSavedState] = useState<'saved' | 'draft' | 'dirty'>(p.cfg ? 'saved' : 'draft');
  const [issues, setIssues] = useState<Record<string, CommandIssue[]>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDone, setAiDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setSaved = (s: 'saved' | 'draft' | 'dirty') => {
    setSavedState(s);
    onDirty(s === 'dirty');
  };
  const touch = () => saved === 'saved' && setSaved('dirty');

  useEffect(() => {
    const t = setTimeout(() => {
      void window.psflow.core.checkCommands(repo, { setup: cmds.setup, lint: cmds.lint, test: cmds.test, run: cmds.run }).then(setIssues).catch(() => setIssues({}));
    }, 350);
    return () => clearTimeout(t);
  }, [repo, cmds.setup, cmds.lint, cmds.test, cmds.run]);

  const edit = (k: Cmd, v: string) => {
    setCmds({ ...cmds, [k]: v });
    setNotes({ ...notes, [k]: v ? 'указано вручную' : '' });
    setSaved('dirty');
  };

  const detectAI = async () => {
    setAiBusy(true);
    setError(null);
    try {
      const r = await window.psflow.core.detectCommandsAI(repo);
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

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveLoaded({ path: repo, cmds, notes, workspace, visualNotes, quickTest, prepare, envFiles: envFiles.split(/[,\n]/).map((f) => f.trim()).filter(Boolean) });
      setSaved('saved');
      onSaved();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel commands">
      <header className="panel-head">
        <div>
          <h2>Команды проекта</h2>
          <p>Подставляются в каждую задачу. Подготовка — один раз перед планом, линтер и тесты — после каждой реализации. Пустое поле — шаг пропускается.</p>
        </div>
        <Button tone={aiDone ? 'ghost' : 'primary'} icon={<Sparkles size={15} />} busy={aiBusy} onClick={() => void detectAI()}>
          {aiBusy ? 'Нейросеть изучает проект…' : aiDone ? 'Найти заново' : 'Найти нейросетью'}
        </Button>
      </header>
      <div className="cmd-list">
        <CmdRow icon={<PackageOpen size={17} />} title="Подготовка" hint="Установка зависимостей" placeholder="не нужна" value={cmds.setup} note={notes.setup} onChange={(v) => edit('setup', v)} loading={aiBusy} issues={issues.setup} />
        <CmdRow icon={<ScanSearch size={17} />} title="Линтер" hint="Линтер и проверка типов" placeholder="не задан" value={cmds.lint} note={notes.lint} onChange={(v) => edit('lint', v)} loading={aiBusy} issues={issues.lint} />
        <CmdRow icon={<TestTubeDiagonal size={17} />} title="Тесты" hint="Все тесты, без watch-режима" placeholder="не заданы" value={cmds.test} note={notes.test} onChange={(v) => edit('test', v)} loading={aiBusy} issues={issues.test} />
        <CmdRow icon={<Zap size={17} />} title="Быстрые тесты" hint="Необязательно. На каждом круге — они, полный набор — один раз перед приёмкой" placeholder="например: npm run test:unit (пусто — всегда полный набор)" value={quickTest} note="" onChange={(v) => { setQuickTest(v); setSaved('dirty'); }} loading={false} />
        <CmdRow icon={<DatabaseZap size={17} />} title="Подготовка к запуску" hint="Необязательно. Перед каждым запуском приложения: миграции, сиды" placeholder="например: cd apps/api && npx prisma migrate deploy" value={prepare} note="" onChange={(v) => { setPrepare(v); setSaved('dirty'); }} loading={false} />
        <CmdRow icon={<MonitorPlay size={17} />} title="Запуск приложения" hint="Для визуальной проверки; {port} — свободный порт" placeholder="например: npm run dev -- --port {port}" value={cmds.run} note={notes.run} onChange={(v) => edit('run', v)} loading={aiBusy} issues={issues.run} />
        <CmdRow icon={<Globe size={17} />} title="Адрес" hint="Главная страница приложения" placeholder="http://localhost:{port}" value={cmds.url} note={notes.url} onChange={(v) => edit('url', v)} loading={aiBusy} />
        <div className="cmd-row">
          <span className="cmd-icon"><GitBranch size={17} /></span>
          <div className="cmd-label">
            <strong>Где работать</strong>
            <span>По умолчанию для новых задач, можно сменить в задаче</span>
          </div>
          <div className="cmd-field">
            <div className="segmented small" role="radiogroup">
              {WORKSPACES.map((w) => (
                <button key={w.id} role="radio" aria-checked={workspace === w.id} className={workspace === w.id ? 'is-on' : ''} onClick={() => { setWorkspace(w.id); touch(); }}>
                  {w.title}
                </button>
              ))}
            </div>
            <span className="cmd-note">{WORKSPACES.find((w) => w.id === workspace)!.hint}</span>
          </div>
        </div>
        <div className="cmd-row">
          <span className="cmd-icon"><FileLock2 size={17} /></span>
          <div className="cmd-label">
            <strong>Файлы окружения</strong>
            <span>Копируются в отдельную копию прогона, не коммитятся</span>
          </div>
          <div className="cmd-field">
            <Input mono placeholder="например: apps/api/.env, apps/web/.env.local" value={envFiles} onChange={(e) => { setEnvFiles(e.target.value); touch(); }} />
            <span className="cmd-note">{p.info.envFiles.length ? `Найдены в проекте: ${p.info.envFiles.join(', ')}` : 'В git их нет, поэтому в worktree без копирования их не будет. В режиме «Ветка» не нужны.'}</span>
          </div>
        </div>
        <div className={`cmd-row ${aiBusy ? 'is-loading' : ''}`}>
          <span className="cmd-icon"><KeyRound size={17} /></span>
          <div className="cmd-label">
            <strong>Инструкция для проверки</strong>
            <span>Тестовый вход, сид данных — для визуальной проверки</span>
          </div>
          <div className="cmd-field">
            <TextArea rows={3} placeholder={'например: вход test@example.com / test1234 (создаётся npm run seed в apps/api), доска — /board'} value={visualNotes} onChange={(e) => { setVisualNotes(e.target.value); touch(); }} />
            <span className="cmd-note">Только тестовые учётки — текст хранится в данных приложения и передаётся агенту как есть.</span>
          </div>
        </div>
        <EnvCheckRow repo={repo} canRun={Boolean(cmds.run.trim() && cmds.url.trim())} dirty={saved !== 'saved'} />
      </div>
      <div className="cmd-actions">
        {error ? <p className="inline-error">{error}</p> : <p className="cmd-foot">Нейросеть только читает файлы проекта — package.json, конфиги, CI — и ничего не меняет.</p>}
        <span className="grow" />
        {saved === 'saved' ? <span className="cmd-saved"><Check size={14} /> Сохранено для проекта</span> : (
          <Button tone="primary" busy={saving} onClick={() => void save()}>Сохранить для проекта</Button>
        )}
      </div>
    </section>
  );
}

/** Проверка окружения: приложение поднимается, вход и разделы из инструкции работают — до того, как запускать задачи. */
function EnvCheckRow({ repo, canRun, dirty }: { repo: string; canRun: boolean; dirty: boolean }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<EnvCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showOut, setShowOut] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await window.psflow.core.checkEnvironment(repo));
    } catch (e) {
      setErr(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cmd-row env-check">
      <span className="cmd-icon"><Stethoscope size={17} /></span>
      <div className="cmd-label">
        <strong>Проверка окружения</strong>
        <span>Поднимает приложение командой запуска и пробует вход и разделы из инструкции — 2–5 минут</span>
      </div>
      <div className="cmd-field">
        <div className="env-check-actions">
          <Button tone="ghost" busy={busy} disabled={!canRun || dirty} onClick={() => void run()}>{busy ? 'Проверяю…' : 'Проверить окружение'}</Button>
          <span className="cmd-note">{!canRun ? 'Нужны команда запуска и адрес.' : dirty ? 'Сначала сохраните команды.' : 'Код и данные не меняются, генерации не запускаются.'}</span>
        </div>
        {err && <p className="inline-error">{err}</p>}
        {res && (
          <div className={`env-result ${res.ready ? 'is-ok' : 'is-bad'}`}>
            <strong>{res.ready ? 'Окружение готово к визуальной проверке' : 'Окружение не готово'}</strong>
            <ul>
              {res.steps.map((s, i) => (
                <li key={i} className={s.ok ? 'is-ok' : 'is-bad'}>
                  {s.ok ? <Check size={13} /> : <X size={13} />}
                  <span><b>{s.title}</b>{s.detail ? ` — ${s.detail}` : ''}</span>
                </li>
              ))}
            </ul>
            {res.fix && <p className="env-fix">{res.fix}</p>}
            {res.serverOutput && (
              <>
                <button className="link" onClick={() => setShowOut(!showOut)}>{showOut ? 'Скрыть вывод сервера' : 'Вывод сервера'}</button>
                {showOut && <pre className="output env-out">{res.serverOutput.replace(/\x1b\[[0-9;]*m/g, '').slice(-6000)}</pre>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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

// ——— Знания о проекте ———

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

/** Профиль проекта набором документов и уроки прошлых прогонов. */
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
