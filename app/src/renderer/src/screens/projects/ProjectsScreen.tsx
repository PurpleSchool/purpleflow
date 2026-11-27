// Экран «Проекты»: все проекты, с которыми работали.
import type { ProjectListItem } from '@purpleflow/core';
import { FolderGit2, Plus, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Topbar } from '../../components/ui';
import { shortPath, when } from '../../lib/format';
import { useStore } from '../../lib/store';
import { listName, plural } from './common';
import { bridge } from '../../lib/api';

// ——— Список проектов ———
export function ProjectsScreen() {
  const { go, state } = useStore();
  const [list, setList] = useState<ProjectListItem[] | null>(null);
  useEffect(() => {
    void bridge.core
      .listProjects()
      .then(setList)
      .catch(() => setList([]));
  }, [state.runs]);

  return (
    <div className="screen">
      <Topbar title="Проекты" sub="Команды, окружение и знания каждого проекта — настраиваются один раз и подставляются в задачи">
        <Button tone="primary" icon={<Plus size={15} />} onClick={() => go({ name: 'addProject' })}>
          Новый проект
        </Button>
      </Topbar>
      <div className="scroll">
        <div className="projects-page">
          {!list ? (
            <div className="center">
              <span className="spinner big" />
            </div>
          ) : list.length === 0 ? (
            <section className="panel knowledge-empty-card">
              <span className="browser-empty-icon">
                <FolderGit2 size={22} />
              </span>
              <strong>Проектов пока нет</strong>
              <p>Откройте папку git-репозитория — приложение найдёт команды проекта и соберёт знания о нём.</p>
              <Button tone="primary" icon={<Rocket size={15} />} onClick={() => go({ name: 'addProject' })}>
                Подключить первый проект
              </Button>
            </section>
          ) : (
            <div className="project-grid">
              {list.map((p, i) => (
                <button
                  key={p.path}
                  className={`project-card ${p.exists ? '' : 'is-missing'}`}
                  style={{ animationDelay: `${i * 0.03}s` }}
                  onClick={() => go({ name: 'project', path: p.path })}
                >
                  <span className="project-card-head">
                    <span className="kdoc-icon">
                      <FolderGit2 size={16} />
                    </span>
                    <span className="project-card-name">
                      <strong>{listName(p)}</strong>
                      <span className="mono">{shortPath(p.path)}</span>
                    </span>
                    {p.active > 0 && (
                      <span className="project-live">
                        <i />
                        {p.active === 1 ? 'идёт прогон' : `прогонов: ${p.active}`}
                      </span>
                    )}
                  </span>
                  <span className="project-card-meta">
                    {!p.exists ? (
                      <span className="tag is-bad">Папка не найдена</span>
                    ) : (
                      !p.configured && <span className="tag is-wait">Не настроен</span>
                    )}
                    <span>{p.runs ? `${p.runs} ${plural(p.runs, 'прогон', 'прогона', 'прогонов')}` : 'Прогонов не было'}</span>
                    {p.lastRunAt && <span>последний {when(p.lastRunAt)}</span>}
                  </span>
                </button>
              ))}
              <button className="project-card is-add" onClick={() => go({ name: 'addProject' })}>
                <Plus size={18} />
                <span>Новый проект</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
