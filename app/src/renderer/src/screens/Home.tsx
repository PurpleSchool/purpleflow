// Главный экран: что делаем — задачу через весь конвейер или чат. Две большие карточки и «Продолжить».
import { ArrowRight, ChevronRight, FolderPlus, MessageSquare, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import { when } from '../lib/format';
import { MODES } from '../lib/stages';
import { useStore } from '../lib/store';
import { ChatTitleText } from '../components/ChatTitle';
import { projectName } from './projects/common';

/** Карточка — одна большая кнопка: значок, стрелка, название и описание внизу. */
function Card({
  kind,
  title,
  desc,
  icon,
  onOpen,
}: {
  kind: 'task' | 'chat';
  title: string;
  desc: string;
  icon: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={`home-card is-${kind}`} onClick={onOpen}>
      <span className="home-card-icon">{icon}</span>
      <ArrowRight size={18} className="home-card-go" />
      <span className="home-card-text">
        <strong>{title}</strong>
        <span>{desc}</span>
      </span>
    </button>
  );
}

export function HomeScreen() {
  const { state, go } = useStore();
  const waiting = state.runs.filter((r) => r.status === 'waiting');
  // «Продолжить» — последние прогоны и чаты вместе, свежие сверху.
  const recent = [
    ...state.runs.map((r) => ({
      kind: 'run' as const,
      id: r.id,
      title: r.title,
      at: r.updatedAt,
      project: r.projectPath,
      mode: r.mode,
      titling: false,
    })),
    ...state.chats.map((c) => ({
      kind: 'chat' as const,
      id: c.id,
      title: c.title,
      at: c.updatedAt,
      project: c.projectPath,
      mode: undefined,
      titling: c.titling,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3);
  return (
    <div className="screen home">
      <div className="home-inner">
        <h1 className="home-title">Что делаем?</h1>
        <div className="home-cards">
          <Card
            kind="chat"
            title="Новый чат"
            desc="Вопросы по коду и небольшие правки — без конвейера, сразу с агентом."
            icon={<MessageSquare size={26} />}
            onOpen={() => go({ name: 'chat' })}
          />
          <Card
            kind="task"
            title="Создать задачу"
            desc="Агенты ведут задачу до готового результата и показывают каждый шаг."
            icon={<Workflow size={26} />}
            onOpen={() => go({ name: 'new' })}
          />
        </div>
        {/* Проект — реже, чем чат и задача: строкой под карточками, открывает мастер «папка → сканирование → готово». */}
        <button type="button" className="home-project" onClick={() => go({ name: 'addProject' })}>
          <span className="home-project-icon">
            <FolderPlus size={16} />
          </span>
          <span className="home-project-text">
            <strong>Новый проект</strong>
            <span>Папка, сканирование — и можно работать</span>
          </span>
          <ArrowRight size={15} className="home-project-go" />
        </button>
        {waiting.length > 0 && (
          <button type="button" className="home-waiting" onClick={() => go({ name: 'run', runId: waiting[0].id })}>
            <span className="home-waiting-dot" />
            {waiting.length === 1 ? `Ждёт вашего решения: ${waiting[0].title}` : `Ждут вашего решения: ${waiting.length}`}
            <ArrowRight size={14} />
          </button>
        )}
        {recent.length > 0 && (
          <section className="home-recent" aria-label="Продолжить">
            <h2>Продолжить</h2>
            <ul>
              {recent.map((it) => (
                <li key={`${it.kind}:${it.id}`}>
                  <button
                    type="button"
                    onClick={() => go(it.kind === 'run' ? { name: 'run', runId: it.id } : { name: 'chat', chatId: it.id })}
                  >
                    <span className={`home-recent-kind is-${it.kind}`}>
                      {it.kind === 'run' ? <Workflow size={14} /> : <MessageSquare size={14} />}
                    </span>
                    <ChatTitleText className="home-recent-title" title={it.title} titling={it.titling} />
                    <span className="home-recent-sub">
                      {it.project ? projectName(it.project) : 'без проекта'} ·{' '}
                      {it.kind === 'run' ? (MODES.find((m) => m.id === (it.mode ?? 'task'))?.title ?? 'Задача') : 'Чат'} · {when(it.at)}
                    </span>
                    <ChevronRight size={14} className="home-recent-go" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
