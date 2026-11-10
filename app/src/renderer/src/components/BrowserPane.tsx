import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WebviewTag } from 'electron';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Monitor,
  RotateCw,
  Smartphone,
  Square,
  SquareMousePointer,
  TriangleAlert,
} from 'lucide-react';
import { CANCEL_PICK_SCRIPT, PICK_SCRIPT, type PickedElement } from '../lib/pickElement';
import type { PreviewState } from '@purpleflow/core';
import { Button } from './ui';
import { onCoreEvent } from '../lib/store';
import { bridge, cleanErr } from '../lib/api';
import { isLocalUrl } from '../../../shared/urls';

/** Состояние приложения прогона для ручной проверки (общее для вкладки и строки приёмки). */
export function usePreview(runId: string) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    bridge.core
      .getPreview(runId)
      .then((s) => alive && setState(s))
      .catch((e) => alive && setError(cleanErr(e)));
    const off = onCoreEvent((e) => {
      if (e.type === 'preview.state' && e.runId === runId) setState(e.state);
    });
    return () => {
      alive = false;
      off();
    };
  }, [runId]);
  const start = async () => {
    setError(null);
    try {
      setState(await bridge.core.startPreview(runId));
    } catch (e) {
      setError(cleanErr(e));
    }
  };
  const stop = () => bridge.core.stopPreview(runId);
  return { state, error, start, stop };
}

type AgentView = { frame: { data: string; url: string } | null; action: string | null };

/**
 * Живая трансляция браузера агента визуальной проверки и его последнее действие.
 * Кадры идут часто и хранятся вне состояния: экран прогона перерисовывается, только когда трансляция началась или кончилась,
 * а каждый кадр получает один AgentScreen. Подписка живёт на экране прогона: Chrome шлёт кадр лишь при изменении страницы,
 * и вкладка, открытая позже, иначе ждала бы следующего.
 */
export function useAgentScreen(runId: string) {
  const [store] = useState(() => {
    let view: AgentView = { frame: null, action: null };
    const subs = new Set<() => void>();
    return {
      get: () => view,
      set(patch: Partial<AgentView>) {
        view = { ...view, ...patch };
        subs.forEach((fn) => fn());
      },
      subscribe(fn: () => void) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    };
  });
  const [live, setLive] = useState(false);
  useEffect(() => {
    let buf = '';
    return onCoreEvent((e) => {
      if (e.type === 'visual.frame' && e.runId === runId) {
        store.set(e.frame ? { frame: { data: e.frame.data, url: e.frame.url } } : { frame: null, action: null });
        setLive(Boolean(e.frame));
      } else if (e.type === 'agent.output' && e.runId === runId && e.stage === 'visual') {
        // Вывод приходит кусками — склеиваем и берём последнюю завершённую строку с командой pw.

        buf = (buf + e.text.replace(/\x1b\[[0-9;]*m/g, '')).slice(-4000);
        const lines = buf.split(/\r?\n/).slice(0, -1);
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/(?:^|[\s;&|(])pw\s+([a-z][a-z-]*[^;&|]*)/);
          if (m) {
            store.set({ action: m[1].trim().slice(0, 120) });
            break;
          }
        }
      }
    });
  }, [runId, store]);
  return { store, live };
}

/** Экран браузера агента: только смотреть, управляет агент. */
export function AgentScreen({ screen }: { screen: ReturnType<typeof useAgentScreen> }) {
  const { frame, action } = useSyncExternalStore(screen.store.subscribe, screen.store.get);
  if (!frame) {
    return (
      <div className="browser-empty">
        <div className="browser-empty-card">
          <span className="spinner big" />
          <strong>Агент открывает браузер…</strong>
          <p>Как только страница загрузится, здесь будет видно всё, что он делает.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="browser is-agent">
      <div className="browser-bar">
        <span className="agent-live">
          <i />
          Агент проверяет
        </span>
        <div className="browser-address">
          <input value={frame.url} readOnly aria-label="Адрес" />
        </div>
        {action && (
          <span className="agent-action" title={action}>
            pw {action}
          </span>
        )}
      </div>
      <div className="browser-stage agent-stage">
        <img className="agent-frame" src={`data:image/jpeg;base64,${frame.data}`} alt="Экран браузера агента" draggable={false} />
      </div>
    </div>
  );
}

/**
 * Вкладка «Браузер»: приложение из ветки прогона во встроенном webview.
 * Отдельная сессия, без preload и Node, только локальные адреса (см. will-attach-webview в main).
 */
export function BrowserPane({
  preview,
  canRun,
  manual = false,
  intro,
  onPick,
}: {
  preview: ReturnType<typeof usePreview>;
  canRun: boolean;
  /** Можно открыть свой адрес (уже запущенный локальный сервер) без команды запуска. */
  manual?: boolean;
  intro?: string;
  /** Есть — в панели кнопка «Указать элемент»: выбранный на странице элемент уходит сюда (в поле ввода чата). */
  onPick?: (el: PickedElement) => void;
}) {
  const { error, start, stop: stopApp } = preview;
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [typed, setTyped] = useState('localhost:3000');
  const [manualError, setManualError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Свой адрес — как запущенное приложение, только останавливать нечего.
  const state: PreviewState = manualUrl ? { status: 'ready', url: manualUrl } : preview.state;
  const stop = async () => {
    if (manualUrl) setManualUrl(null);
    else await stopApp();
  };
  const openManual = () => {
    const t = typed.trim();
    if (!t) return;
    const url = /^https?:\/\//.test(t) ? t : `http://${t}`;
    // Вкладка показывает только приложение на этой машине: главный процесс не подключит webview с чужим адресом.
    if (!isLocalUrl(url)) return setManualError('Здесь открываются только адреса на этой машине (localhost, 127.0.0.1).');
    setManualError(null);
    setManualUrl(url);
  };
  const view = useRef<WebviewTag | null>(null);
  const [address, setAddress] = useState('');
  const [nav, setNav] = useState({ back: false, forward: false, loading: false });
  const [mobile, setMobile] = useState(false);
  const ready = state.status === 'ready' && state.url;

  useEffect(() => {
    const w = view.current;
    if (!w || !ready) return;
    const sync = () => {
      try {
        setAddress(w.getURL());
        setNav({ back: w.canGoBack(), forward: w.canGoForward(), loading: w.isLoading() });
      } catch {
        /* webview ещё не готов */
      }
    };
    const loading = () => {
      setLoadError(null);
      setNav((n) => ({ ...n, loading: true }));
    };
    const failed = (e: Electron.DidFailLoadEvent) => {
      // -3 — навигацию отменили (новый переход или адрес ушёл в обычный браузер), это не сбой.
      if (e.isMainFrame && e.errorCode !== -3)
        setLoadError(`Страница не открылась: ${e.errorDescription || e.errorCode} — ${e.validatedURL}`);
    };
    w.addEventListener('did-navigate', sync);
    w.addEventListener('did-navigate-in-page', sync);
    w.addEventListener('did-stop-loading', sync);
    w.addEventListener('did-start-loading', loading);
    w.addEventListener('dom-ready', sync);
    w.addEventListener('did-fail-load', failed);
    return () => {
      w.removeEventListener('did-navigate', sync);
      w.removeEventListener('did-navigate-in-page', sync);
      w.removeEventListener('did-stop-loading', sync);
      w.removeEventListener('did-start-loading', loading);
      w.removeEventListener('dom-ready', sync);
      w.removeEventListener('did-fail-load', failed);
    };
  }, [ready, state.url]);

  const go = () => {
    const w = view.current;
    if (!w || !state.url) return;
    let target = address.trim();
    if (target.startsWith('/')) target = new URL(target, state.url).toString();
    else if (!/^https?:\/\//.test(target)) target = `http://${target}`;
    void w.loadURL(target).catch(() => {});
  };

  // Выбор элемента: скрипт в странице подсвечивает элемент под курсором и отдаёт описание по клику.
  const [picking, setPicking] = useState(false);
  const togglePick = async () => {
    const w = view.current;
    if (!w || !onPick) return;
    if (picking) return void w.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => {});
    setPicking(true);
    setLoadError(null);
    try {
      const el = (await w.executeJavaScript(PICK_SCRIPT, true)) as PickedElement | null;
      if (el) onPick(el);
    } catch {
      // Страница ушла на другой адрес посреди выбора — просто выходим из режима.
    } finally {
      setPicking(false);
    }
  };
  // Уход со страницы или со вкладки снимает выбор.
  useEffect(() => {
    if (!picking) return;
    const w = view.current;
    const reset = () => setPicking(false);
    w?.addEventListener('did-start-loading', reset);
    return () => {
      w?.removeEventListener('did-start-loading', reset);
      void w?.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => {});
    };
  }, [picking]);

  const toggleMobile = (m: boolean) => {
    setMobile(m);
    const w = view.current;
    if (w) void bridge.previewEmulate(w.getWebContentsId(), m);
  };

  if (!ready) {
    return (
      <div className="browser-empty">
        <div className="browser-empty-card">
          <span className="browser-empty-icon">
            {state.status === 'failed' || error ? <TriangleAlert size={22} /> : <Globe size={22} />}
          </span>
          {state.status === 'starting' ? (
            <>
              <strong>Запускаю приложение…</strong>
              <p>
                <code>{state.command}</code>
              </p>
              <p className="muted">Ждём ответа на {state.url}</p>
              <span className="spinner big" />
              <Button tone="quiet" onClick={() => void stop()}>
                Отменить
              </Button>
            </>
          ) : state.status === 'failed' ? (
            <>
              <strong>Приложение не запустилось</strong>
              <p>{state.error}</p>
              {state.output && <pre className="browser-output">{state.output.trim().split('\n').slice(-20).join('\n')}</pre>}
              <Button tone="primary" icon={<RotateCw size={14} />} onClick={() => void start()}>
                Попробовать снова
              </Button>
            </>
          ) : (
            <>
              <strong>Проверьте результат сами</strong>
              <p>
                {intro ??
                  'Приложение поднимется из ветки прогона на свободном порту и откроется прямо здесь — можно протыкать изменения перед приёмкой.'}
              </p>
              {error && <p className="browser-error">{error}</p>}
              {canRun ? (
                <Button tone="primary" icon={<Globe size={15} />} onClick={() => void start()}>
                  Открыть приложение
                </Button>
              ) : (
                <p className="muted">
                  Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты»){manual ? ' или откройте адрес вручную' : ''}
                  .
                </p>
              )}
              {manualError && <p className="browser-error">{manualError}</p>}
              {manual && (
                <form
                  className="browser-manual"
                  onSubmit={(e) => {
                    e.preventDefault();
                    openManual();
                  }}
                >
                  <input
                    className="input mono"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="localhost:3000"
                    aria-label="Адрес"
                    spellCheck={false}
                  />
                  <Button tone={canRun ? 'ghost' : 'primary'} type="submit">
                    Открыть адрес
                  </Button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <Button tone="quiet" icon={<ArrowLeft size={16} />} title="Назад" disabled={!nav.back} onClick={() => view.current?.goBack()} />
        <Button
          tone="quiet"
          icon={<ArrowRight size={16} />}
          title="Вперёд"
          disabled={!nav.forward}
          onClick={() => view.current?.goForward()}
        />
        <Button
          tone="quiet"
          icon={<RotateCw size={15} className={nav.loading ? 'spin' : ''} />}
          title="Обновить"
          onClick={() => view.current?.reload()}
        />
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} aria-label="Адрес" />
        </form>
        {onPick && (
          <Button
            tone="quiet"
            className={`browser-pick ${picking ? 'is-on' : ''}`}
            icon={<SquareMousePointer size={15} />}
            title={picking ? 'Отменить выбор (Esc)' : 'Указать элемент на странице — описание попадёт в поле ввода чата'}
            aria-label="Указать элемент"
            aria-pressed={picking}
            onClick={() => void togglePick()}
          />
        )}
        <div className="segmented small" role="radiogroup" aria-label="Устройство">
          <button
            role="radio"
            aria-checked={!mobile}
            className={!mobile ? 'is-on' : ''}
            title="Десктоп"
            onClick={() => toggleMobile(false)}
          >
            <Monitor size={14} />
          </button>
          <button role="radio" aria-checked={mobile} className={mobile ? 'is-on' : ''} title="Телефон" onClick={() => toggleMobile(true)}>
            <Smartphone size={14} />
          </button>
        </div>
        <Button
          tone="quiet"
          icon={<ExternalLink size={15} />}
          title="Открыть в системном браузере"
          onClick={() => void window.open(address || state.url, '_blank')}
        />
        <Button
          tone="quiet"
          icon={<Square size={13} />}
          title={manualUrl ? 'Закрыть страницу' : 'Остановить приложение'}
          onClick={() => void stop()}
        />
      </div>
      {loadError && <p className="browser-error browser-load-error">{loadError}</p>}
      {picking && <p className="browser-pick-hint">Наведите на элемент и нажмите — описание попадёт в чат. Esc — отмена.</p>}
      <div className={`browser-stage ${mobile ? 'is-mobile' : ''}`}>
        <webview
          ref={(el) => {
            view.current = el as unknown as WebviewTag | null;
          }}
          src={state.url}
          partition="purpleflow-preview"
          className="browser-view"
        />
      </div>
    </div>
  );
}
