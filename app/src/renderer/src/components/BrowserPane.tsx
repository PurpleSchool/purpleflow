import { useEffect, useRef, useState } from 'react';
import type { WebviewTag } from 'electron';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Monitor, RotateCw, Smartphone, Square, TriangleAlert } from 'lucide-react';
import type { PreviewState } from '@purpleflow/core';
import { Button } from './ui';
import { onCoreEvent } from '../lib/store';

const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Состояние приложения прогона для ручной проверки (общее для вкладки и строки приёмки). */
export function usePreview(runId: string) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.purpleflow.core.getPreview(runId).then((s) => alive && setState(s));
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
      setState(await window.purpleflow.core.startPreview(runId));
    } catch (e) {
      setError(cleanErr(e));
    }
  };
  const stop = () => window.purpleflow.core.stopPreview(runId);
  return { state, error, start, stop };
}

/** Живая трансляция браузера агента визуальной проверки и его последнее действие. */
export function useAgentScreen(runId: string) {
  const [frame, setFrame] = useState<{ data: string; url: string } | null>(null);
  const [action, setAction] = useState<string | null>(null);
  useEffect(() => {
    setFrame(null);
    setAction(null);
    let buf = '';
    return onCoreEvent((e) => {
      if (e.type === 'visual.frame' && e.runId === runId) {
        setFrame(e.frame ? { data: e.frame.data, url: e.frame.url } : null);
        if (!e.frame) setAction(null);
      } else if (e.type === 'agent.output' && e.runId === runId && e.stage === 'visual') {
        // Вывод приходит кусками — склеиваем и берём последнюю завершённую строку с командой pw.
        // eslint-disable-next-line no-control-regex
        buf = (buf + e.text.replace(/\x1b\[[0-9;]*m/g, '')).slice(-4000);
        const lines = buf.split(/\r?\n/).slice(0, -1);
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/(?:^|[\s;&|(])pw\s+([a-z][a-z-]*[^;&|]*)/);
          if (m) {
            setAction(m[1].trim().slice(0, 120));
            break;
          }
        }
      }
    });
  }, [runId]);
  return { frame, action };
}

/** Экран браузера агента: только смотреть, управляет агент. */
export function AgentScreen({ screen }: { screen: ReturnType<typeof useAgentScreen> }) {
  const { frame, action } = screen;
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
        <span className="agent-live"><i />Агент проверяет</span>
        <div className="browser-address"><input value={frame.url} readOnly aria-label="Адрес" /></div>
        {action && <span className="agent-action" title={action}>pw {action}</span>}
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
export function BrowserPane({ preview, canRun, manual = false, intro }: {
  preview: ReturnType<typeof usePreview>; canRun: boolean;
  /** Можно открыть свой адрес (уже запущенный локальный сервер) без команды запуска. */
  manual?: boolean;
  intro?: string;
}) {
  const { error, start, stop: stopApp } = preview;
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [typed, setTyped] = useState('localhost:3000');
  // Свой адрес — как запущенное приложение, только останавливать нечего.
  const state: PreviewState = manualUrl ? { status: 'ready', url: manualUrl } : preview.state;
  const stop = async () => {
    if (manualUrl) setManualUrl(null);
    else await stopApp();
  };
  const openManual = () => {
    const t = typed.trim();
    if (!t) return;
    setManualUrl(/^https?:\/\//.test(t) ? t : `http://${t}`);
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
      } catch { /* webview ещё не готов */ }
    };
    const loading = () => setNav((n) => ({ ...n, loading: true }));
    w.addEventListener('did-navigate', sync);
    w.addEventListener('did-navigate-in-page', sync);
    w.addEventListener('did-stop-loading', sync);
    w.addEventListener('did-start-loading', loading);
    w.addEventListener('dom-ready', sync);
    return () => {
      w.removeEventListener('did-navigate', sync);
      w.removeEventListener('did-navigate-in-page', sync);
      w.removeEventListener('did-stop-loading', sync);
      w.removeEventListener('did-start-loading', loading);
      w.removeEventListener('dom-ready', sync);
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

  const toggleMobile = (m: boolean) => {
    setMobile(m);
    const w = view.current;
    if (w) void window.purpleflow.previewEmulate(w.getWebContentsId(), m);
  };

  if (!ready) {
    return (
      <div className="browser-empty">
        <div className="browser-empty-card">
          <span className="browser-empty-icon">{state.status === 'failed' || error ? <TriangleAlert size={22} /> : <Globe size={22} />}</span>
          {state.status === 'starting' ? (
            <>
              <strong>Запускаю приложение…</strong>
              <p><code>{state.command}</code></p>
              <p className="muted">Ждём ответа на {state.url}</p>
              <span className="spinner big" />
              <Button tone="quiet" onClick={() => void stop()}>Отменить</Button>
            </>
          ) : state.status === 'failed' ? (
            <>
              <strong>Приложение не запустилось</strong>
              <p>{state.error}</p>
              {state.output && <pre className="browser-output">{state.output.trim().split('\n').slice(-20).join('\n')}</pre>}
              <Button tone="primary" icon={<RotateCw size={14} />} onClick={() => void start()}>Попробовать снова</Button>
            </>
          ) : (
            <>
              <strong>Проверьте результат сами</strong>
              <p>{intro ?? 'Приложение поднимется из ветки прогона на свободном порту и откроется прямо здесь — можно протыкать изменения перед приёмкой.'}</p>
              {error && <p className="browser-error">{error}</p>}
              {canRun ? (
                <Button tone="primary" icon={<Globe size={15} />} onClick={() => void start()}>Открыть приложение</Button>
              ) : (
                <p className="muted">Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты»){manual ? ' или откройте адрес вручную' : ''}.</p>
              )}
              {manual && (
                <form className="browser-manual" onSubmit={(e) => { e.preventDefault(); openManual(); }}>
                  <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="localhost:3000" aria-label="Адрес" spellCheck={false} />
                  <Button tone={canRun ? 'ghost' : 'primary'} type="submit">Открыть адрес</Button>
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
        <Button tone="quiet" icon={<ArrowRight size={16} />} title="Вперёд" disabled={!nav.forward} onClick={() => view.current?.goForward()} />
        <Button tone="quiet" icon={<RotateCw size={15} className={nav.loading ? 'spin' : ''} />} title="Обновить" onClick={() => view.current?.reload()} />
        <form className="browser-address" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <input value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} aria-label="Адрес" />
        </form>
        <div className="segmented small" role="radiogroup" aria-label="Устройство">
          <button role="radio" aria-checked={!mobile} className={!mobile ? 'is-on' : ''} title="Десктоп" onClick={() => toggleMobile(false)}><Monitor size={14} /></button>
          <button role="radio" aria-checked={mobile} className={mobile ? 'is-on' : ''} title="Телефон" onClick={() => toggleMobile(true)}><Smartphone size={14} /></button>
        </div>
        <Button tone="quiet" icon={<ExternalLink size={15} />} title="Открыть в системном браузере" onClick={() => void window.open(address || state.url, '_blank')} />
        <Button tone="quiet" icon={<Square size={13} />} title={manualUrl ? 'Закрыть страницу' : 'Остановить приложение'} onClick={() => void stop()} />
      </div>
      <div className={`browser-stage ${mobile ? 'is-mobile' : ''}`}>
        <webview ref={(el) => { view.current = el as unknown as WebviewTag | null; }} src={state.url} partition="purpleflow-preview" className="browser-view" />
      </div>
    </div>
  );
}
