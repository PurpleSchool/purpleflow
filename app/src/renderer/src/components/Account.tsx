import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, Plus } from 'lucide-react';
import type { AccountKey } from '../../../shared/ipc';
import { Button, Field, Input } from './ui';
import { useStore } from '../lib/store';

export const PRIVACY_URL = 'https://purpleschool.ru/privacy-policy.pdf';
const MIN_PASSWORD = 8;

/** Чем вход через PurpleSchool лучше своих подписок — по странице purpleschool.ru/ai-for-code. */
export const ACCOUNT_BENEFITS = [
  { title: 'Без VPN', text: 'Claude и GPT работают из России напрямую, без средств обхода блокировок.' },
  { title: 'Оплата в рублях', text: 'Российские карты и СБП — зарубежная карта не нужна.' },
  { title: 'Один ключ на всё', text: 'Общий баланс токенов для claude и codex во всех ролях.' },
  { title: 'Дешевле на 10%', text: 'Те же модели, что в официальных API, а расход виден по каждому запросу.' },
];

type Mode = 'login' | 'register' | 'restore';

/** Вход, регистрация и восстановление пароля PurpleSchool. onDone — вошли или зарегистрировались. */
export function AuthForms({ onDone, initial = 'login' }: { onDone: () => void | Promise<void>; initial?: Mode }) {
  const { reloadSettings } = useStore();
  const [mode, setMode] = useState<Mode>(initial);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mailing, setMailing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; toLogin?: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const switchTo = (m: Mode) => {
    setMode(m);
    setError(null);
    setNotice(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    const mail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(mail)) return setError({ text: 'Введите email полностью, например name@mail.ru' });
    if (mode === 'register') {
      if (!name.trim()) return setError({ text: 'Как к вам обращаться? Введите имя' });
      if (password.length < MIN_PASSWORD) return setError({ text: `Пароль — не короче ${MIN_PASSWORD} символов` });
    }
    if (mode === 'login' && !password) return setError({ text: 'Введите пароль' });
    setBusy(true);
    try {
      if (mode === 'restore') {
        const r = await window.psflow.account.restore(mail);
        if (r.ok) setNotice(r.data);
        else setError({ text: r.error });
        return;
      }
      const r = mode === 'login'
        ? await window.psflow.account.login(mail, password)
        : await window.psflow.account.register({ name, email: mail, password, mailing });
      if (!r.ok) return setError({ text: r.error, toLogin: r.code === 'exists' });
      setPassword('');
      await reloadSettings();
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth" onSubmit={(e) => void submit(e)} noValidate>
      <h2>{mode === 'login' ? 'Вход в PurpleSchool' : mode === 'register' ? 'Регистрация в PurpleSchool' : 'Восстановление пароля'}</h2>
      {mode === 'restore' && <p className="auth-sub">Пришлём ссылку для смены пароля. Пароль меняется на сайте PurpleSchool, затем возвращайтесь и входите здесь.</p>}
      {mode === 'register' && (
        <Field label="Имя">
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      )}
      <Field label="Email">
        <Input type="email" autoComplete="email" placeholder="name@mail.ru" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={mode !== 'register'} />
      </Field>
      {mode !== 'restore' && (
        <Field
          label="Пароль"
          aside={mode === 'login' && <button type="button" className="link auth-aside" onClick={() => switchTo('restore')}>Забыли пароль?</button>}
          hint={mode === 'register' ? `Не короче ${MIN_PASSWORD} символов` : undefined}
        >
          <Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}
      {mode === 'register' && (
        <label className="auth-check">
          <input type="checkbox" checked={mailing} onChange={(e) => setMailing(e.target.checked)} />
          <span>Получать новости и рекламные рассылки</span>
        </label>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error.text}
          {error.toLogin && <> · <button type="button" className="link" onClick={() => switchTo('login')}>Войти</button></>}
        </p>
      )}
      {notice && <p className="auth-notice" role="status"><CheckCircle2 size={15} /> {notice}</p>}
      <Button tone="primary" type="submit" busy={busy} className="auth-submit">
        {mode === 'login' ? 'Войти' : mode === 'register' ? 'Зарегистрироваться' : 'Отправить ссылку'}
      </Button>
      {mode === 'register' && (
        <p className="auth-legal">
          Регистрируясь, вы соглашаетесь с <a className="link" href={PRIVACY_URL} target="_blank" rel="noreferrer">политикой конфиденциальности</a> PurpleSchool.
        </p>
      )}
      <p className="auth-switch">
        {mode === 'login' ? (
          <>Нет аккаунта? <button type="button" className="link" onClick={() => switchTo('register')}>Зарегистрироваться</button></>
        ) : (
          <>{mode === 'register' ? 'Уже есть аккаунт?' : 'Вспомнили пароль?'} <button type="button" className="link" onClick={() => switchTo('login')}>Войти</button></>
        )}
      </p>
    </form>
  );
}

/**
 * Ключ AI-прокси из аккаунта: подставленный, выбор из активных, создание нового.
 */
export function AccountKeys({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const { state, reloadSettings } = useStore();
  const [keys, setKeys] = useState<AccountKey[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasKey = state.settings?.proxy.hasKey;

  const fail = async (r: { error: string; code?: string }) => {
    setError(r.error);
    if (r.code === 'unauthorized') {
      await reloadSettings();
      onUnauthorized?.();
    }
  };

  const load = async () => {
    const r = await window.psflow.account.keys();
    if (!r.ok) return fail(r);
    setKeys(r.data.items);
    setLimit(r.data.limit);
  };

  useEffect(() => {
    void (async () => {
      // Сначала подставляем существующий ключ, если своего ещё нет, потом показываем список.
      const auto = await window.psflow.account.autoKey();
      if (!auto.ok) return fail(auto);
      if (auto.data === 'picked') await reloadSettings();
      await load();
    })();
  }, [hasKey]);

  const act = async (id: string, fn: () => Promise<{ ok: true } | { ok: false; error: string; code?: string }>) => {
    setBusy(id);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) return fail(r);
      await reloadSettings();
      await load();
    } finally {
      setBusy(null);
    }
  };

  const active = keys?.filter((k) => k.active) ?? [];
  const current = keys?.find((k) => k.current);
  return (
    <div className="acc-keys">
      {!keys && !error && <div className="acc-keys-loading"><span className="spinner" /> Загружаем ключи аккаунта…</div>}
      {keys && active.length === 0 && (
        <div className="acc-key-offer">
          <KeyRound size={18} />
          <div>
            <strong>В аккаунте ещё нет ключа AI-прокси</strong>
            <p>Создадим ключ «PurpleFlow» и подставим его — агенты пойдут через PurpleSchool.</p>
          </div>
          <Button tone="primary" icon={<Plus size={15} />} busy={busy === 'create'} onClick={() => void act('create', window.psflow.account.createKey)}>
            Создать ключ
          </Button>
        </div>
      )}
      {keys && active.length > 0 && (
        <div className="acc-key-list">
          {active.map((k) => (
            <div key={k.id} className={`acc-key ${k.current ? 'is-current' : ''}`}>
              <KeyRound size={14} />
              <strong>{k.name}</strong>
              <span className="mono muted">…{k.tail}</span>
              <span className="grow" />
              {k.current ? (
                <span className="acc-key-used"><CheckCircle2 size={13} /> используется</span>
              ) : (
                <Button tone="quiet" busy={busy === `use-${k.id}`} onClick={() => void act(`use-${k.id}`, () => window.psflow.account.useKey(k.id))}>
                  Использовать
                </Button>
              )}
            </div>
          ))}
          <div className="acc-key-foot">
            {!current && hasKey && <span className="muted">Сейчас подставлен ключ не из этого аккаунта — выберите ключ выше.</span>}
            <span className="grow" />
            {active.length < limit && (
              <button className="link" disabled={busy !== null} onClick={() => void act('create', window.psflow.account.createKey)}>
                {busy === 'create' ? 'Создаём…' : 'Создать новый ключ'}
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p className="auth-error" role="alert">{error}</p>}
    </div>
  );
}
