// Вкладка «Аккаунт»: вход в PurpleSchool, ключи AI-прокси и переключатель «Работать через PurpleSchool».
import { useState } from 'react';
import { Check, KeyRound, LogOut } from 'lucide-react';
import { ACCOUNT_BENEFITS, AccountKeys, AuthForms } from '../../components/Account';
import { EmailBonus } from '../../components/EmailBonus';
import { MediaModels, MediaPromo } from '../../components/MediaModels';
import { TrialBanner } from '../../components/TrialPromo';
import { Button } from '../../components/ui';
import { bridge } from '../../lib/api';
import { useStore } from '../../lib/store';
import { CheckButton, ChecksList } from './parts';
import type { SettingsDraft } from './useSettingsDraft';

export function AccountTab({ draft }: { draft: SettingsDraft }) {
  const { state, saveSettings, reloadSettings } = useStore();
  const s = state.settings!;
  const { checks, setChecks } = draft;
  const proxyOn = s.proxy.hasKey && s.proxy.enabled;
  // Кнопка баннера переключает форму на регистрацию: новый key пересоздаёт форму с нужным режимом.
  const [authMode, setAuthMode] = useState<{ mode: 'login' | 'register'; n: number }>({ mode: 'login', n: 0 });
  /** Выход удаляет токен аккаунта; ключ прокси остаётся — его можно удалить отдельно. */
  const logout = async () => {
    await bridge.account.logout();
    await reloadSettings();
    setChecks(null);
  };
  return (
    <section className="panel">
      {s.account ? (
        <>
          <header className="panel-head">
            <div>
              <h2>Аккаунт PurpleSchool</h2>
              <p>
                Агенты работают через AI-прокси PurpleSchool по ключу вашего аккаунта — без VPN. Без ключа агенты работают по вашим обычным
                подпискам.
              </p>
            </div>
            {proxyOn && <CheckButton draft={draft} />}
          </header>
          <div className="acc-card">
            <div className="acc-profile">
              <span className="acc-avatar" aria-hidden>
                {s.account.photo ? (
                  <img src={s.account.photo} alt="" />
                ) : (
                  (s.account.name || s.account.email || '?').trim().charAt(0).toUpperCase()
                )}
              </span>
              <div className="acc-profile-text">
                <strong>{s.account.name || s.account.email}</strong>
                <span>{s.account.name ? s.account.email : 'Аккаунт PurpleSchool'}</span>
              </div>
              <span className="grow" />
              <Button tone="quiet" icon={<LogOut size={14} />} onClick={() => void logout()}>
                Выйти
              </Button>
            </div>
            <EmailBonus />
            {s.proxy.hasKey && (
              <div className={`acc-proxy ${s.proxy.enabled ? 'is-on' : ''}`}>
                <div className="acc-proxy-text">
                  <strong>
                    Работать через PurpleSchool <span className="acc-state">{s.proxy.enabled ? 'включено' : 'выключено'}</span>
                  </strong>
                  <span>
                    {s.proxy.enabled
                      ? 'Агенты ходят в модели по ключу ниже — без VPN, расход идёт с баланса аккаунта.'
                      : 'Ключ сохранён, но не используется: агенты работают по вашим обычным подпискам.'}
                  </span>
                </div>
                <button
                  role="switch"
                  aria-checked={s.proxy.enabled}
                  aria-label="Работать через PurpleSchool"
                  className={`switch acc-switch ${s.proxy.enabled ? 'is-on' : ''}`}
                  onClick={() => void saveSettings({ proxy: { enabled: !s.proxy.enabled } })}
                >
                  <i />
                </button>
              </div>
            )}
            {/* Картинки через MCP PurpleSchool — по тому же ключу аккаунта, независимо от «Работать через PurpleSchool». */}
            {s.proxy.hasKey && <MediaModels />}
            <AccountKeys />
          </div>
        </>
      ) : (
        // Без входа: описание и преимущества слева, форма справа — от верха плашки.
        <div className="acc-signin">
          <div className="acc-intro">
            <header className="panel-head">
              <div>
                <h2>Аккаунт PurpleSchool</h2>
                <p>Агенты работают через AI-прокси PurpleSchool. Без входа — по вашим подпискам.</p>
              </div>
            </header>
            <TrialBanner onRegister={() => setAuthMode((a) => ({ mode: 'register', n: a.n + 1 }))} />
            <MediaPromo />
            <ul className="acc-benefits">
              {ACCOUNT_BENEFITS.map((b) => (
                <li key={b.title}>
                  <Check size={13} />
                  {b.title}
                </li>
              ))}
            </ul>
          </div>
          <div className="acc-form bezel">
            <AuthForms key={authMode.n} initial={authMode.mode} onDone={() => undefined} />
          </div>
        </div>
      )}
      {s.proxy.hasKey && !s.account && (
        <div className="user-config acc-use">
          <button
            role="switch"
            aria-checked={s.proxy.enabled}
            className={`switch ${s.proxy.enabled ? 'is-on' : ''}`}
            onClick={() => void saveSettings({ proxy: { enabled: !s.proxy.enabled } })}
          >
            <i />
            <span>Работать через PurpleSchool</span>
          </button>
          <p>
            {s.proxy.enabled
              ? 'Агенты ходят в модели по ключу AI-прокси PurpleSchool.'
              : 'Ключ сохранён, но не используется: агенты работают по вашим обычным подпискам. Аккаунт остаётся подключённым.'}
          </p>
        </div>
      )}
      {s.proxy.hasKey && !s.account && (
        <p className="acc-legacy">
          <KeyRound size={13} /> Сохранён ключ, вставленный раньше вручную. Войдите, чтобы управлять ключами аккаунта, или{' '}
          <button className="link" onClick={() => void saveSettings({ proxy: { apiKey: '' } })}>
            удалите его
          </button>
          .
        </p>
      )}
      {checks && <ChecksList checks={checks} />}
    </section>
  );
}
