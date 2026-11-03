// Визуальная проверка: скриншоты агента и просмотр их во весь экран.
import type { RunFile, StageAttempt } from '@purpleflow/core';
import { CircleCheck, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PillTabs } from '../../../components/PillTabs';
import { LiveLog, type LogSlice } from '../../../components/Terminal';
import { Button, Empty } from '../../../components/ui';
import { bridge, cleanErr } from '../../../lib/api';
import { ServerOutput } from './ChecksViews';

/** Визуальная проверка: вердикт и галерея скриншотов. */
export function VisualView({ run, runId, idx, attempt }: { run: RunFile; runId: string; idx: number; attempt?: StageAttempt }) {
  const running = attempt?.status === 'running';
  // Результат — только у завершённой попытки; у упавшей (сбой агента) или идущей — сразу лог.
  const v = running || (attempt && attempt.status === 'failed' && !run.visuals?.[idx]) ? undefined : run.visuals?.[idx];
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [big, setBig] = useState<number | null>(null);
  const [tab, setTab] = useState<'result' | 'server' | 'log'>(v ? 'result' : 'log');
  useEffect(() => {
    let alive = true;
    if (!v) return;
    void Promise.all(v.shots.map(async (s) => [s.file, await bridge.core.getVisualShot(runId, s.file).catch(() => null)] as const)).then(
      (pairs) => {
        // Удалённый очисткой хранилища скриншот — пустая строка: показываем заглушку, а не вечный спиннер.
        if (alive) setUrls(Object.fromEntries(pairs.map(([f, u]) => [f, u ?? ''])));
      },
    );
    return () => {
      alive = false;
    };
  }, [runId, v]);
  const slice: LogSlice | null = attempt
    ? { title: 'Визуальная проверка', attempt: attempt.attempt, stage: 'visual', live: running }
    : null;
  // Повторить можно последнюю проверку, пока прогон ждёт решения или остановлен (например, после правки команды запуска).
  const canRerun = !running && idx === (run.visuals?.length ?? 0) - 1 && (run.status === 'waiting' || run.status === 'stopped');
  const [rerunning, setRerunning] = useState(false);
  const [rerunErr, setRerunErr] = useState<string | null>(null);
  const rerun = async () => {
    setRerunning(true);
    setRerunErr(null);
    try {
      await bridge.core.dispatch({ type: 'run.rerunVisual', runId });
    } catch (e) {
      setRerunErr(cleanErr(e));
    } finally {
      setRerunning(false);
    }
  };
  if (!v && !slice)
    return (
      <Empty icon={<Sparkles />} title="Визуальной проверки ещё не было">
        Приложение запустится после ревью.
      </Empty>
    );
  const items = v
    ? [...v.blocking.map((x) => ({ ...x, kind: 'blocking' as const })), ...v.notes.map((x) => ({ ...x, kind: 'note' as const }))]
    : [];
  const shown = v ? tab : 'log';
  const shotUrls = v ? v.shots.map((s) => urls[s.file]).filter(Boolean) : [];
  return (
    <div className="agent-out">
      {v && (
        <div className="agent-out-tabs">
          <PillTabs<'result' | 'server' | 'log'>
            className="tabs small"
            value={shown}
            onChange={setTab}
            items={[
              { id: 'result', label: 'Результат' },
              ...(v.serverOutput ? [{ id: 'server' as const, label: 'Вывод сервера' }] : []),
              { id: 'log', label: 'Лог' },
            ]}
          />
        </div>
      )}
      {shown === 'log' && slice ? (
        <div className="pane-log">
          <LiveLog runId={runId} slice={slice} />
        </div>
      ) : shown === 'server' && v?.serverOutput ? (
        <div className="agent-result scroll tab-enter">
          <ServerOutput command={v.command} output={v.serverOutput} />
        </div>
      ) : v ? (
        <div className="agent-result scroll tab-enter">
          <div className="review">
            {v.unverified ? (
              <div className="verdict is-warn">
                <span className="verdict-mark">!</span>
                <div>
                  <strong>
                    {/^Нестабильное окружение:/i.test(v.unverified) ? 'Окружение вело себя нестабильно' : 'Проверить не удалось'}
                  </strong>
                  <p>{v.unverified.replace(/^Нестабильное окружение:\s*/i, '')}</p>
                  <p className="muted">
                    {/^Нестабильное окружение:/i.test(v.unverified)
                      ? 'Интерфейс не реагировал даже после перезагрузки, а ошибок в коде задачи не видно — похоже на сбой dev-сервера или браузера. Задача не вернулась исполнителю: проверьте сами во вкладке «Браузер» или перезапустите проверку.'
                      : 'Это не ошибка реализации — задача не вернулась исполнителю. Проверьте сами во вкладке «Браузер»; тестовый вход и подготовку данных можно описать в «Инструкции для проверки» в настройках проекта.'}
                  </p>
                </div>
              </div>
            ) : null}
            {v.unverified && v.serverOutput && /error|Missing script|EADDRINUSE|ECONNREFUSED/i.test(v.serverOutput) && (
              <button className="link server-link" onClick={() => setTab('server')}>
                В выводе сервера есть ошибки — открыть
              </button>
            )}
            {canRerun && (
              <div className="visual-rerun">
                <Button tone="ghost" icon={<RotateCcw size={14} />} busy={rerunning} onClick={() => void rerun()}>
                  Проверить ещё раз
                </Button>
                <span className="muted">Команда запуска и адрес — из настроек проекта: если вы их поправили, проверка возьмёт новые.</span>
                {rerunErr && <span className="actionbar-error">{rerunErr}</span>}
              </div>
            )}
            {!v.unverified && (
              <div className={`verdict ${v.blocking.length ? 'is-bad' : 'is-ok'}`}>
                <span className="verdict-mark">{v.blocking.length ? v.blocking.length : <CircleCheck size={22} />}</span>
                <div>
                  <strong>{v.blocking.length ? `Видимых проблем: ${v.blocking.length}` : 'В браузере всё выглядит верно'}</strong>
                  <p>
                    {v.url} · скриншотов: {v.shots.length} · заметок: {v.notes.length}
                  </p>
                </div>
              </div>
            )}
            <div className="shots">
              {v.shots.map((s) => (
                <figure key={s.file} className="shot">
                  <button onClick={() => urls[s.file] && setBig(shotUrls.indexOf(urls[s.file]))}>
                    {urls[s.file] ? (
                      <img src={urls[s.file]} alt={s.caption} />
                    ) : urls[s.file] === '' ? (
                      <span className="muted shot-gone">Скриншот удалён</span>
                    ) : (
                      <span className="spinner" />
                    )}
                  </button>
                  <figcaption>{s.caption}</figcaption>
                </figure>
              ))}
            </div>
            {items.length > 0 && (
              <ul className="review-list">
                {items.map((x, i) => (
                  <li key={i} className={`note n-${x.kind}`}>
                    {x.file && <span className="note-loc">{x.file}</span>}
                    <p>{x.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
      {big !== null && shotUrls[big] && (
        <Lightbox
          src={shotUrls[big]}
          caption={v?.shots.find((s) => urls[s.file] === shotUrls[big])?.caption}
          onClose={() => setBig(null)}
          onPrev={big > 0 ? () => setBig(big - 1) : undefined}
          onNext={big < shotUrls.length - 1 ? () => setBig(big + 1) : undefined}
        />
      )}
    </div>
  );
}
/** Просмотр изображения на всё окно (через портал — не зависит от прокрутки и анимаций панели). ←/→ — соседние, Esc — закрыть. */
export function Lightbox({
  src,
  caption,
  onClose,
  onPrev,
  onNext,
}: {
  src: string;
  caption?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onPrev?.();
      else if (e.key === 'ArrowRight') onNext?.();
      else return;
      // Esc и стрелки не должны дойти до экрана прогона (там они закрывают детали и листают стадии).
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, onPrev, onNext]);
  return createPortal(
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Изображение">
      <img src={src} alt={caption ?? ''} onClick={(e) => e.stopPropagation()} />
      {caption && <p className="lightbox-caption">{caption}</p>}
      {onPrev && (
        <button
          className="lightbox-nav is-prev"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          aria-label="Предыдущий"
        >
          ‹
        </button>
      )}
      {onNext && (
        <button
          className="lightbox-nav is-next"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label="Следующий"
        >
          ›
        </button>
      )}
    </div>,
    document.body,
  );
}
