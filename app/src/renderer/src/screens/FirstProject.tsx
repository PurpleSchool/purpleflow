// Первый проект: выбрать папку, просканировать нейросетью (команды и знания) и подключить — три шага до первой задачи.
import { ArrowRight, BookText, Check, FolderGit2, FolderOpen, ScanSearch, TerminalSquare, TriangleAlert, Zap } from 'lucide-react';
import type { AgentKind } from '@purpleflow/core';
import { useRef, useState, type ReactNode } from 'react';
import { Mark } from '../components/Sidebar';
import { Button } from '../components/ui';
import { bridge, cleanErr } from '../lib/api';
import { shortPath } from '../lib/format';
import { useStore } from '../lib/store';
import { CmdChips, type LoadedProject, loadProject, saveLoaded } from './projects/common';
import { AgentSwitch } from './settings/parts';

type Job = 'idle' | 'busy' | 'done' | 'error';

export function FirstProjectScreen() {
  const { state, go, saveSettings } = useStore();
  const found = (a: AgentKind) => Boolean(state.tools?.[a].path && !state.tools[a].error);
  // Как в настройках: не выбран — claude, если он установлен, иначе codex. Второй агент подстрахует, если первый не настроен.
  const scanAgent: AgentKind = state.settings?.agents.scan ?? (state.tools && !found('claude') ? 'codex' : 'claude');
  const pickScanAgent = (a: AgentKind) => {
    if (a === scanAgent && state.settings?.agents.scan) return;
    // Имя модели одного CLI другому не подходит — сбрасываем на модель по умолчанию.
    void saveSettings({ agents: { scan: a }, models: { scan: '' } }).catch((e) => setScanError(cleanErr(e)));
  };
  const [p, setP] = useState<LoadedProject | null>(null);
  const [picking, setPicking] = useState(false);
  const [cmdJob, setCmdJob] = useState<Job>('idle');
  const [profileJob, setProfileJob] = useState<Job>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Сканирование, начатое для прошлой папки, не должно перезаписать команды новой.
  const current = useRef<string | null>(null);

  const pick = async () => {
    setPicking(true);
    setError(null);
    try {
      const dir = await bridge.pickFolder('Папка проекта');
      if (!dir) return;
      current.current = dir;
      const x = await loadProject(dir);
      if (current.current !== dir) return;
      setP(x);
      setCmdJob('idle');
      setProfileJob('idle');
      setScanError(null);
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setPicking(false);
    }
  };

  const scan = () => {
    if (!p) return;
    const dir = p.info.path;
    setScanError(null);
    setCmdJob('busy');
    setProfileJob('busy');
    const fail = (e: unknown) => current.current === dir && setScanError((prev) => prev ?? cleanErr(e));
    // Команды и знания ищутся параллельно: профиль дольше, но для подключения он не обязателен.
    void bridge.core
      .detectCommandsAI(dir)
      .then((r) => {
        if (current.current !== dir) return;
        setP((cur) =>
          cur && cur.info.path === dir
            ? {
                ...cur,
                cmds: { setup: r.setupCommand, lint: r.lintCommand, test: r.testCommand, run: r.runCommand, url: r.appUrl },
                notes: { setup: r.notes.setup, lint: r.notes.lint, test: r.notes.test, run: r.notes.run, url: '' },
                visualNotes: r.visualNotes || cur.visualNotes,
              }
            : cur,
        );
        setCmdJob('done');
      })
      .catch((e) => {
        fail(e);
        if (current.current === dir) setCmdJob('error');
      });
    void bridge.core
      .refreshProfile(dir)
      .then(() => current.current === dir && setProfileJob('done'))
      .catch((e) => {
        fail(e);
        if (current.current === dir) setProfileJob('error');
      });
  };

  const connect = async () => {
    if (!p) return;
    setConnecting(true);
    setError(null);
    try {
      await saveLoaded({ ...p, path: p.info.path });
      go({ name: 'new', project: p.info.path });
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setConnecting(false);
    }
  };

  const repo = Boolean(p?.info.isRepo);
  const scanning = cmdJob === 'busy' || profileJob === 'busy';
  const scanned = cmdJob === 'done';

  return (
    <div className="onboard">
      <div className="onboard-drag drag" aria-hidden />
      <div className="fp">
        <header className="fp-head">
          <div className="onboard-logo">
            <Mark size={52} />
          </div>
          <h1>Первый проект</h1>
          <p>Три шага — и можно ставить задачу. Всё, что найдём, потом можно поправить в настройках проекта.</p>
        </header>

        <ol className="fp-steps">
          <Step n={1} title="Папка проекта" state={repo ? 'done' : 'active'}>
            {p ? (
              <div className="fp-project">
                <span className="fp-project-icon">
                  <FolderGit2 size={18} />
                </span>
                <span className="fp-project-name">
                  <strong>{p.info.name}</strong>
                  <span className="mono">{shortPath(p.info.path)}</span>
                </span>
                <Button tone="quiet" busy={picking} onClick={() => void pick()}>
                  Сменить
                </Button>
              </div>
            ) : (
              <>
                <p className="fp-text">
                  Выберите папку git-репозитория — агенты будут работать в отдельной ветке, ваша копия не изменится.
                </p>
                <Button tone="primary" icon={<FolderOpen size={16} />} busy={picking} onClick={() => void pick()}>
                  Выбрать папку…
                </Button>
              </>
            )}
            {p && !repo && (
              <p className="inline-error">
                <TriangleAlert size={14} /> Это не git-репозиторий. Выполните <code>git init</code> и первый коммит или выберите другую
                папку.
              </p>
            )}
          </Step>

          <Step n={2} title="Сканирование" state={!repo ? 'pending' : scanned ? 'done' : 'active'} optional>
            <p className="fp-text">
              Нейросеть найдёт команды установки, линтера, тестов и запуска и соберёт знания о проекте — стек, структуру, соглашения. Займёт
              пару минут.
            </p>
            {repo && (
              <div className="fp-scan">
                <ScanRow icon={<TerminalSquare size={16} />} title="Команды проекта" job={cmdJob}>
                  {p && <CmdChips cmds={p.cmds} />}
                  {cmdJob === 'idle' && p?.info.detectedFrom && <span className="muted">найдено по {p.info.detectedFrom}</span>}
                </ScanRow>
                <ScanRow icon={<BookText size={16} />} title="Знания о проекте" job={profileJob}>
                  <span className="muted">
                    {profileJob === 'done'
                      ? 'Профиль собран'
                      : profileJob === 'busy'
                        ? 'Изучаю проект…'
                        : profileJob === 'error'
                          ? 'Не собран — соберётся перед первым планом'
                          : 'Соберётся перед первым планом, если не сканировать'}
                  </span>
                </ScanRow>
              </div>
            )}
            {scanError && (
              <p className="inline-error">
                <TriangleAlert size={14} /> {scanError}
              </p>
            )}
            <div className="fp-actions">
              <Button tone={scanned ? 'ghost' : 'primary'} icon={<ScanSearch size={16} />} disabled={!repo} busy={scanning} onClick={scan}>
                {scanning ? 'Сканирую…' : scanned ? 'Сканировать заново' : 'Сканировать проект'}
              </Button>
              {found('claude') && found('codex') ? (
                <span className="fp-agent">
                  <span className="muted">Агент</span>
                  <AgentSwitch label="Сканирование проекта" value={scanAgent} onChange={pickScanAgent} />
                </span>
              ) : (
                state.tools && <span className="muted">Сканирует {scanAgent}</span>
              )}
            </div>
          </Step>

          <Step n={3} title="Подключение" state={!repo ? 'pending' : 'active'}>
            <p className="fp-text">
              {scanned
                ? 'Команды найдены — подключим проект и перейдём к первой задаче.'
                : 'Можно не ждать сканирования: подключим с общими настройками — команды по файлам проекта, работа в отдельном worktree.'}
              {profileJob === 'busy' && ' Знания дособерутся в фоне.'}
            </p>
            {error && (
              <p className="inline-error">
                <TriangleAlert size={14} /> {error}
              </p>
            )}
            <div className="fp-actions">
              <Button
                tone="primary"
                icon={scanned ? <ArrowRight size={16} /> : <Zap size={16} />}
                disabled={!repo || cmdJob === 'busy'}
                busy={connecting}
                onClick={() => void connect()}
              >
                {scanned ? 'Подключить и создать задачу' : 'Быстрое подключение'}
              </Button>
              {p && repo && (
                <button className="link" onClick={() => go({ name: 'project', path: p.info.path, tab: 'commands' })}>
                  Настроить вручную
                </button>
              )}
            </div>
          </Step>
        </ol>

        <button className="link fp-skip" onClick={() => go({ name: 'new' })}>
          Пропустить — подключу проект позже
        </button>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  state,
  optional,
  children,
}: {
  n: number;
  title: string;
  state: 'pending' | 'active' | 'done';
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={`fp-step is-${state}`}>
      <span className="fp-num">{state === 'done' ? <Check size={14} /> : n}</span>
      <div className="fp-body">
        <h2>
          {title}
          {optional && <span className="tag">по желанию</span>}
        </h2>
        {children}
      </div>
    </li>
  );
}

function ScanRow({ icon, title, job, children }: { icon: ReactNode; title: string; job: Job; children: ReactNode }) {
  return (
    <div className={`fp-scan-row is-${job}`}>
      <span className="fp-scan-icon">{job === 'busy' ? <span className="spinner" /> : job === 'done' ? <Check size={16} /> : icon}</span>
      <strong>{title}</strong>
      <span className="fp-scan-info">{children}</span>
    </div>
  );
}
