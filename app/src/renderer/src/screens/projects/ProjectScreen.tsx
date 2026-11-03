// Страница проекта с вкладками «Обзор», «Команды и окружение», «Знания о проекте».
import { Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';
import { PillTabs } from '../../components/PillTabs';
import { Button, Topbar } from '../../components/ui';
import { shortPath } from '../../lib/format';
import { useActions, type ProjectTab } from '../../lib/store';
import { CommandsPanel } from './Commands';
import { KnowledgeView } from './Knowledge';
import { Overview } from './Overview';
import { type LoadedProject, loadProject, projectName } from './common';
import { cleanErr } from '../../lib/api';

// ——— Страница проекта ———
export function ProjectScreen({ path, initialTab }: { path: string; initialTab?: ProjectTab }) {
  const { go } = useActions();
  const [tab, setTab] = useState<ProjectTab>(initialTab ?? 'overview');
  const [p, setP] = useState<LoadedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const reload = () =>
    loadProject(path)
      .then(setP)
      .catch((e) => setError(cleanErr(e)));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- проект перечитывается при смене пути; после правок — вызовом reload()
  }, [path]);

  const repo = p?.info.isRepo;
  const commandsOpened = useRef(false);
  if (tab === 'commands') commandsOpened.current = true;
  return (
    <div className="screen">
      <Topbar
        title={p?.info.name ?? projectName(path)}
        sub={
          <span className="mono topbar-path" title={path}>
            {shortPath(path)}
          </span>
        }
      >
        <Button tone="primary" icon={<Plus size={15} />} disabled={!repo} onClick={() => go({ name: 'new', project: path })}>
          Новая задача
        </Button>
      </Topbar>
      <div className="page-tabs">
        <PillTabs<ProjectTab>
          className="tabs"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'overview', label: 'Обзор' },
            {
              id: 'commands',
              label: 'Команды и окружение',
              disabled: !repo,
              extra: repo && (!p?.cfg || dirty) ? <span className="tab-dot" title="Не сохранены" /> : undefined,
            },
            { id: 'knowledge', label: 'Знания о проекте', disabled: !repo },
          ]}
        />
      </div>
      <div className="scroll">
        <div className="project-page">
          {error && (
            <p className="inline-error">
              <TriangleAlert size={14} /> {error}
            </p>
          )}
          {!p ? (
            !error && (
              <div className="center">
                <span className="spinner big" />
              </div>
            )
          ) : (
            <>
              {(tab === 'overview' || !repo) && (
                <div className="project-tab step-enter">
                  <Overview p={p} onTab={setTab} />
                </div>
              )}
              {/* Команды живут и на других вкладках: иначе несохранённые правки терялись бы при переключении. */}
              {repo && (tab === 'commands' || commandsOpened.current) && (
                <div className={`project-tab ${tab === 'commands' ? 'step-enter' : ''}`} hidden={tab !== 'commands'}>
                  <CommandsPanel p={p} onSaved={() => void reload()} onDirty={setDirty} />
                </div>
              )}
              {repo && tab === 'knowledge' && (
                <div className="project-tab step-enter">
                  <KnowledgeView repo={p.info.path} name={p.info.name} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
