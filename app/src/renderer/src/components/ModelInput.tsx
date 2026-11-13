// Поле модели: ComboInput, который не даёт молча выбрать модель «только по подписке PurpleSchool», когда прокси не работает,
// а предлагает включить PurpleSchool или войти в аккаунт.
import { X } from 'lucide-react';
import { useEffect, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { cleanErr } from '../lib/api';
import { PROXY_ONLY_TITLE, proxyOnly } from '../lib/models';
import { useStore } from '../lib/store';
import { ComboInput } from './Dropdown';
import { Button } from './ui';

export function ModelInput(props: ComponentProps<typeof ComboInput>) {
  const { state } = useStore();
  const proxy = state.settings?.proxy;
  const viaProxy = Boolean(proxy?.enabled && proxy.hasKey);
  const [gate, setGate] = useState<string | null>(null);
  const blocked = (v: string) => !viaProxy && proxyOnly(props.options, v);

  const apply = (v: string) => {
    props.onChange(v);
    props.onCommit?.(v);
  };

  return (
    <>
      <ComboInput
        {...props}
        onChange={(v) => {
          if (blocked(v)) setGate(v.trim());
          else props.onChange(v);
        }}
        onCommit={(v) => {
          if (!blocked(v)) props.onCommit?.(v);
        }}
      />
      {gate && <SubscriptionGate model={gate} onClose={() => setGate(null)} onEnabled={() => apply(gate)} />}
    </>
  );
}

/** Модель доступна только по подписке PurpleSchool: включить её (ключ уже есть) или войти и получить ключ. */
function SubscriptionGate({ model, onClose, onEnabled }: { model: string; onClose: () => void; onEnabled: () => void }) {
  const { state, saveSettings, go } = useStore();
  const s = state.settings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!s) return null;
  const hasKey = s.proxy.hasKey;

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveSettings({ proxy: { enabled: true } });
      onEnabled();
      onClose();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  const toAccount = () => {
    onClose();
    go({ name: 'settings', tab: 'account' });
  };

  const text = hasKey
    ? 'Ключ AI-прокси сохранён, но работа через PurpleSchool выключена. Включите её — и модель сразу выберется. Расход пойдёт с баланса аккаунта.'
    : s.accountEnabled
      ? s.account
        ? 'Для неё нужен ключ AI-прокси PurpleSchool. Получите его на вкладке «Аккаунт», затем выберите модель снова.'
        : 'Войдите или зарегистрируйтесь в PurpleSchool и подключите ключ AI-прокси на вкладке «Аккаунт», затем выберите модель снова.'
      : 'Нужен ключ AI-прокси PurpleSchool, а в этой сборке вход в аккаунт выключен.';

  return createPortal(
    <div className="qs-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qs sub-gate" role="dialog" aria-modal aria-labelledby="sub-gate-title">
        <header className="qs-head">
          <div>
            <h2 id="sub-gate-title">Модель по подписке PurpleSchool</h2>
            <p>
              <code>{model}</code> — {PROXY_ONLY_TITLE.charAt(0).toLowerCase() + PROXY_ONLY_TITLE.slice(1)}
            </p>
            <p>{text}</p>
            {error && <p className="inline-error">{error}</p>}
          </div>
          <button className="qs-close" aria-label="Закрыть" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <footer className="qs-foot">
          <Button tone="quiet" onClick={onClose}>
            Отмена
          </Button>
          {hasKey ? (
            <Button tone="primary" busy={busy} onClick={() => void enable()}>
              Включить PurpleSchool
            </Button>
          ) : (
            s.accountEnabled && (
              <Button tone="primary" onClick={toAccount}>
                {s.account ? 'Получить ключ' : 'Войти в PurpleSchool'}
              </Button>
            )
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
