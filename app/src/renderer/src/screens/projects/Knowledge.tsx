// Вкладка «Знания о проекте»: профиль и уроки прошлых прогонов.
import type { ProjectKnowledge } from '@purpleflow/core';
import { BookText, FileText, FlaskConical, FolderTree, Layers, Lightbulb, PencilLine, Play, Sparkles, Workflow, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import { Button, TextArea } from '../../components/ui';
import { bridge, cleanErr } from '../../lib/api';

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
  const parts = md
    .split(/^##\s+/m)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 && !/^##\s/m.test(md)) return md.trim() ? [{ title: 'Профиль', body: md.trim() }] : [];
  return parts.map((p) => {
    const nl = p.indexOf('\n');
    return nl < 0 ? { title: p, body: '' } : { title: p.slice(0, nl).trim(), body: p.slice(nl + 1).trim() };
  });
}
/** Профиль проекта набором документов и уроки прошлых прогонов. */
export function KnowledgeView({ repo, name }: { repo: string; name: string }) {
  const [k, setK] = useState<ProjectKnowledge | null>(null);
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState('');
  const [busy, setBusy] = useState<'save' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void bridge.core.getKnowledge(repo).then((x) => {
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
  if (!k)
    return (
      <div className="center">
        <span className="spinner big" />
      </div>
    );
  const docs = splitProfile(k.profile ?? '');
  const lessons = k.lessons ?? [];
  const removeLesson = (i: number) =>
    void run('save', () => bridge.core.saveKnowledge(repo, { ...k, lessons: lessons.filter((_, j) => j !== i) }));
  return (
    <div className="knowledge-view">
      <section className="panel knowledge-intro">
        <header className="panel-head">
          <div>
            <h2>Знания о проекте {name}</h2>
            <p>
              Получают все агенты — чтобы не изучать проект с нуля в каждом прогоне. Профиль собирается сам перед первым планом, уроки
              добавляются после прогонов: из ваших правок, замечаний ревью и сбоев проверок.
            </p>
          </div>
          <div className="knowledge-actions">
            {k.profile && !editing && (
              <Button tone="quiet" icon={<PencilLine size={15} />} onClick={() => setEditing(true)}>
                Редактировать
              </Button>
            )}
            <Button
              tone="ghost"
              icon={<Sparkles size={15} />}
              busy={busy === 'refresh'}
              disabled={busy !== null}
              onClick={() => void run('refresh', () => bridge.core.refreshProfile(repo))}
            >
              {busy === 'refresh' ? 'Изучаю проект…' : k.profile ? 'Пересобрать профиль' : 'Изучить проект'}
            </Button>
          </div>
        </header>
        {k.profileAt && (
          <p className="muted knowledge-date">
            Профиль собран{' '}
            {new Date(k.profileAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · уроков:{' '}
            {lessons.length}
          </p>
        )}
        {error && <p className="inline-error">{error}</p>}
      </section>

      {editing ? (
        <section className="panel">
          <TextArea rows={22} className="mono knowledge-profile" value={profile} onChange={(e) => setProfile(e.target.value)} />
          <div className="cmd-actions">
            <p className="cmd-foot">Разделы — заголовками «## Стек», «## Структура»… — каждый станет отдельной карточкой.</p>
            <span className="grow" />
            <Button
              tone="quiet"
              onClick={() => {
                setProfile(k.profile ?? '');
                setEditing(false);
              }}
            >
              Отмена
            </Button>
            <Button
              tone="primary"
              busy={busy === 'save'}
              onClick={() => void run('save', () => bridge.core.saveKnowledge(repo, { ...k, profile }))}
            >
              Сохранить
            </Button>
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
          <span className="browser-empty-icon">
            <Sparkles size={22} />
          </span>
          <strong>Профиль ещё не собран</strong>
          <p>Соберётся сам перед первым планом в этом проекте — или нажмите «Изучить проект».</p>
        </section>
      )}

      <article className="kdoc kdoc-lessons">
        <header>
          <span className="kdoc-icon">
            <Lightbulb size={16} />
          </span>
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
                  <button className="lesson-del" title="Удалить урок" onClick={() => removeLesson(i)}>
                    <X size={14} />
                  </button>
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
