import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, Plus } from 'lucide-react';
import type { AccountKey } from '../../../shared/ipc';
import { Button, Field, Input } from './ui';
import { useStore } from '../lib/store';
import { bridge } from '../lib/api';

export const PRIVACY_URL = 'https://purpleschool.ru/privacy-policy.pdf';
const MIN_PASSWORD = 8;

/** Чем вход через PurpleSchool лучше своих подписок — по странице purpleschool.ru/ai-for-code. */
export const ACCOUNT_BENEFITS = [
  { title: 'Без VPN', text: 'Claude и GPT работают из России напрямую, без средств обхода блокировок.' },
  { title: 'Оплата в рублях', text: 'Российские карты и СБП — зарубежная карта не нужна.' },
  { title: 'Один ключ на всё', text: 'Общий баланс токенов для claude и codex во всех ролях.' },
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
        const r = await bridge.account.restore(mail);
        if (r.ok) setNotice(r.data);
        else setError({ text: r.error });
        return;
      }
      const r =
        mode === 'login'
          ? await bridge.account.login(mail, password)
          : await bridge.account.register({ name, email: mail, password, mailing });
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
      {mode === 'restore' && (
        <p className="auth-sub">
          Пришлём ссылку для смены пароля. Пароль меняется на сайте PurpleSchool, затем возвращайтесь и входите здесь.
        </p>
      )}
      {mode === 'register' && (
        <Field label="Имя">
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      )}
      <Field label="Email">
        <Input
          type="email"
          autoComplete="email"
          placeholder="name@mail.ru"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus={mode !== 'register'}
        />
      </Field>
      {mode !== 'restore' && (
        <Field
          label="Пароль"
          aside={
            mode === 'login' && (
              <button type="button" className="link auth-aside" onClick={() => switchTo('restore')}>
                Забыли пароль?
              </button>
            )
          }
          hint={mode === 'register' ? `Не короче ${MIN_PASSWORD} символов` : undefined}
        >
          <Input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
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
          {error.toLogin && (
            <>
              {' '}
              ·{' '}
              <button type="button" className="link" onClick={() => switchTo('login')}>
                Войти
              </button>
            </>
          )}
        </p>
      )}
      {notice && (
        <p className="auth-notice" role="status">
          <CheckCircle2 size={15} /> {notice}
        </p>
      )}
      <Button tone="primary" type="submit" busy={busy} className="auth-submit">
        {mode === 'login' ? 'Войти' : mode === 'register' ? 'Зарегистрироваться' : 'Отправить ссылку'}
      </Button>
      {mode === 'register' && (
        <p className="auth-legal">
          Регистрируясь, вы соглашаетесь с{' '}
          <a className="link" href={PRIVACY_URL} target="_blank" rel="noreferrer">
            политикой конфиденциальности
          </a>{' '}
          PurpleSchool.
        </p>
      )}
      <p className="auth-switch">
        {mode === 'login' ? (
          <>
            Нет аккаунта?{' '}
            <button type="button" className="link" onClick={() => switchTo('register')}>
              Зарегистрироваться
            </button>
          </>
        ) : (
          <>
            {mode === 'register' ? 'Уже есть аккаунт?' : 'Вспомнили пароль?'}{' '}
            <button type="button" className="link" onClick={() => switchTo('login')}>
              Войти
            </button>
          </>
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
    const r = await bridge.account.keys();
    if (!r.ok) return fail(r);
    setKeys(r.data.items);
    setLimit(r.data.limit);
  };

  useEffect(() => {
    void (async () => {
      // Сначала подставляем существующий ключ, если своего ещё нет, потом показываем список.
      const auto = await bridge.account.autoKey();
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
  const create = () => void act('create', bridge.account.createKey);
  return (
    <div className="acc-keys">
      <div className="acc-keys-head">
        <strong>Ключ AI-прокси</strong>
        {keys && active.length > 0 && (
          <span className="muted">
            {active.length} из {limit}
          </span>
        )}
        <span className="grow" />
        {keys && active.length > 0 && active.length < limit && (
          <Button
            tone="quiet"
            icon={<Plus size={14} />}
            busy={busy === 'create'}
            disabled={busy !== null && busy !== 'create'}
            onClick={create}
          >
            Новый ключ
          </Button>
        )}
      </div>
      {!keys && !error && (
        <div className="acc-keys-loading">
          <span className="spinner" /> Загружаем ключи аккаунта…
        </div>
      )}
      {keys && active.length === 0 && (
        <div className="acc-key-offer">
          <span className="acc-key-icon">
            <KeyRound size={16} />
          </span>
          <div>
            <strong>В аккаунте ещё нет ключа</strong>
            <p>Создадим ключ «PurpleFlow» и подставим его — агенты пойдут через PurpleSchool.</p>
          </div>
          <Button tone="primary" icon={<Plus size={15} />} busy={busy === 'create'} onClick={create}>
            Создать ключ
          </Button>
        </div>
      )}
      {active.length > 0 && (
        <div className="acc-key-list">
          {active.map((k) => (
            <div key={k.id} className={`acc-key ${k.current ? 'is-current' : ''}`}>
              <span className="acc-key-icon">
                <KeyRound size={16} />
              </span>
              <div className="acc-key-text">
                <strong>{k.name}</strong>
                <span>
                  Создан {shortDate(k.createdAt)} · {k.lastUsedAt ? `использовался ${ago(k.lastUsedAt)}` : 'ещё не использовался'}
                </span>
              </div>
              <code className="acc-key-mask">•••• {k.tail}</code>
              {k.current ? (
                <span className="acc-key-used">
                  <CheckCircle2 size={14} /> Подставлен
                </span>
              ) : (
                <Button
                  tone="ghost"
                  busy={busy === `use-${k.id}`}
                  disabled={busy !== null && busy !== `use-${k.id}`}
                  onClick={() => void act(`use-${k.id}`, () => bridge.account.useKey(k.id))}
                >
                  Использовать
                </Button>
              )}
            </div>
          ))}
          {!current && hasKey && <p className="acc-key-note">Сейчас подставлен ключ не из этого аккаунта — выберите ключ из списка.</p>}
        </div>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function shortDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
}

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 2) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const days = Math.round(h / 24);
  return days < 30 ? `${days} дн назад` : shortDate(iso);
}
