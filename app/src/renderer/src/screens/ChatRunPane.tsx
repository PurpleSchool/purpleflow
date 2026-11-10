// Вкладка «Запуск» чата с проектом: команда из настроек проекта, старт, стоп, перезапуск и вывод сервера.
import { useEffect, useRef, useState } from 'react';
import { Globe, Play, RotateCw, Settings2, Square, TriangleAlert } from 'lucide-react';
import type { ProjectConfig } from '@purpleflow/core';
import type { usePreview } from '../components/BrowserPane';
import { Button, Empty } from '../components/ui';
import { shortPath } from '../lib/format';
import { useStore } from '../lib/store';

/** Цвета терминала в логе не нужны. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const STATUS = {
  idle: { label: 'Не запущено', tone: '' },
  starting: { label: 'Запускается…', tone: 'is-live' },
  ready: { label: 'Работает', tone: 'is-ok' },
  failed: { label: 'Не запустилось', tone: 'is-error' },
} as const;

export function ChatRunPane({
  projectPath,
  cfg,
  preview,
  onOpenBrowser,
}: {
  projectPath: string;
  /** null — настройки ещё грузятся или их нет. */
  cfg: ProjectConfig | null;
  preview: ReturnType<typeof usePreview>;
  onOpenBrowser: () => void;
}) {
  const { go } = useStore();
  const { state, error, start, stop } = preview;
  const [restarting, setRestarting] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  // Лог прокручивается за выводом, пока человек сам не отмотал его вверх.
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.output]);

  const settings = () => go({ name: 'project', path: projectPath, tab: 'commands' });

  if (!cfg?.runCommand || !cfg.appUrl)
    return (
      <div className="chat-run">
        <Empty
          icon={<Play />}
          title="Запуск не настроен"
          action={
            <Button tone="primary" icon={<Settings2 size={14} />} onClick={settings}>
              Настроить запуск
            </Button>
          }
        >
          Укажите в настройках проекта команду «Запуск приложения» и «Адрес» — приложение будет запускаться отсюда кнопкой, без просьб
          агенту.
        </Empty>
      </div>
    );

  const st = STATUS[state.status];
  const running = state.status === 'starting' || state.status === 'ready';
  const restart = async () => {
    setRestarting(true);
    try {
      await stop();
      await start();
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="chat-run">
      <section className="ses-card chat-run-card">
        <div className="chat-run-head">
          <span className={`chat-run-status ${st.tone}`} role="status">
            <span className="chat-run-dot" />
            {restarting ? 'Перезапускается…' : st.label}
          </span>
          <span className="chat-run-actions">
            {running ? (
              <>
                {state.status === 'ready' && (
                  <Button tone="quiet" icon={<Globe size={14} />} title="Открыть в браузере" onClick={onOpenBrowser}>
                    В браузере
                  </Button>
                )}
                <Button tone="quiet" icon={<RotateCw size={14} />} busy={restarting} onClick={() => void restart()}>
                  Перезапустить
                </Button>
                <Button tone="ghost" icon={<Square size={12} />} onClick={() => void stop()}>
                  Остановить
                </Button>
              </>
            ) : (
              <Button tone="primary" icon={<Play size={14} />} onClick={() => void start()}>
                {state.status === 'failed' ? 'Запустить снова' : 'Запустить'}
              </Button>
            )}
          </span>
        </div>
        <div className="ses-row">
          <span className="ses-label">Команда</span>
          <code className="ses-value chat-run-code">{state.command ?? cfg.runCommand}</code>
        </div>
        <div className="ses-row">
          <span className="ses-label">Адрес</span>
          <span className="ses-value">
            {state.url ? (
              <code className="chat-run-code">{state.url}</code>
            ) : (
              <span className="ses-hint">
                <code>{cfg.appUrl}</code> — порт подберётся свободный
              </span>
            )}
          </span>
        </div>
        <div className="ses-row">
          <span className="ses-label">Папка</span>
          <span className="ses-value" title={projectPath}>
            {shortPath(projectPath)}
          </span>
        </div>
        <button type="button" className="chat-run-settings" onClick={settings}>
          <Settings2 size={13} /> Изменить в настройках проекта
        </button>
        {(state.status === 'failed' || error) && (
          <p className="chat-run-error">
            <TriangleAlert size={14} /> {error ?? state.error}
          </p>
        )}
      </section>

      <section className="chat-run-log">
        <div className="chat-run-log-head">Вывод сервера</div>
        {state.output ? (
          <pre
            ref={log}
            aria-label="Вывод сервера"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {stripAnsi(state.output)}
          </pre>
        ) : (
          <p className="ses-hint chat-run-log-empty">
            {state.status === 'idle' ? 'Появится после запуска.' : 'Сервер пока ничего не написал.'}
          </p>
        )}
      </section>
    </div>
  );
}
