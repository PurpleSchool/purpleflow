// «Картинки, видео и озвучка» в аккаунте: переключатель MCP PurpleSchool для чата и модели, доступные по ключу аккаунта.
import { useEffect, useState, type CSSProperties } from 'react';
import { AudioLines, Clapperboard, CreditCard, Image as ImageIcon } from 'lucide-react';
import type { MediaModel } from '../../../shared/ipc';
import { bridge } from '../lib/api';
import { useStore } from '../lib/store';
import { PLANS_URL } from './AccountStats';
import { VendorIcon } from './VendorIcon';

/** Как называть модели и для чего они: id — как в MCP; новых, которых здесь нет, показываем по id. */
export const ABOUT: Record<string, { name: string; vendor: string; use: string }> = {
  'nano-banana-2.1': { name: 'Nano Banana 2.1', vendor: 'Google', use: 'Обложки, иллюстрации и редактирование по фото' },
  'flux-3-klein': { name: 'Flux 3 Klein', vendor: 'Black Forest Labs', use: 'Быстрые черновики и серии изображений' },
  'gpt-image-2': { name: 'GPT Image 2', vendor: 'OpenAI', use: 'Текст на картинке, инфографика и интерфейсы' },
  'nano-banana-pro': { name: 'Nano Banana Pro', vendor: 'Google', use: 'Высокая детализация и постоянный образ персонажа' },
  'qwen-image-3': { name: 'Qwen Image 3', vendor: 'Alibaba', use: 'Мелкий текст и многоязычные иллюстрации' },
};

const credits = (n: number) => `${n.toLocaleString('ru-RU')} кредитов`;

export function MediaModels() {
  const { state, saveSettings } = useStore();
  const s = state.settings!;
  const on = s.media.enabled;
  const [models, setModels] = useState<{ models: MediaModel[]; default: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Картинки рисуются за непробный баланс (подписка или пакет): нет его — плашка «Оформить подписку». null — ещё не знаем.
  const [hasPlan, setHasPlan] = useState<boolean | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void bridge.account.paidBalance().then((r) => alive && r.ok && setHasPlan(r.data));
    return () => {
      alive = false;
    };
  }, [on]);
  useEffect(() => {
    if (!on || !s.proxy.hasKey) return;
    let alive = true;
    setError(null);
    void bridge.account.mediaModels().then((r) => {
      if (!alive) return;
      if (r.ok) setModels(r.data);
      else setError(r.error || 'Не удалось получить модели');
    });
    return () => {
      alive = false;
    };
  }, [on, s.proxy.hasKey]);

  return (
    <div className={`acc-media ${on ? 'is-on' : ''}`}>
      <div className="acc-proxy">
        <div className="acc-proxy-text">
          <strong>
            Картинки, видео и озвучка в чате <span className="acc-state">{on ? 'включено' : 'выключено'}</span>
          </strong>
          <span>
            {on
              ? 'Попросите в чате «нарисуй иконку для кнопки оплаты» — агент выберет модель, нарисует и покажет картинку. Платно, только по прямой просьбе.'
              : 'Агент не подключает MCP-сервер PurpleSchool и не может рисовать.'}
          </span>
        </div>
        <button
          role="switch"
          aria-checked={on}
          aria-label="Картинки, видео и озвучка в чате"
          className={`switch acc-switch ${on ? 'is-on' : ''}`}
          onClick={() => void saveSettings({ media: { enabled: !on } })}
        >
          <i />
        </button>
      </div>
      {on && hasPlan === false && (
        <div className="acc-media-plan">
          <CreditCard size={16} />
          <span>
            Картинки рисуются за подписку или пакет PurpleSchool — пробного баланса для них не хватит. Оформите подписку, и агент сможет
            рисовать.
          </span>
          <a className="btn btn-primary" href={PLANS_URL} target="_blank" rel="noreferrer">
            Оформить подписку
          </a>
        </div>
      )}
      {on && (
        <>
          <div className="acc-media-kinds">
            <span className="is-on">
              <ImageIcon size={14} /> Картинки{' '}
              {models ? <em>{models.models.length}</em> : !error && <em className="is-loading" aria-hidden />}
            </span>
            <span>
              <Clapperboard size={14} /> Видео <em>скоро</em>
            </span>
            <span>
              <AudioLines size={14} /> Озвучка <em>скоро</em>
            </span>
          </div>
          {error && <p className="acc-media-error">{error}</p>}
          {/* Пока модели грузятся — заглушки того же размера, что и карточки: сетка не прыгает, карточки плавно проявляются. */}
          {!models && !error && (
            <ul className="acc-media-grid is-loading" aria-label="Загружаю модели" aria-busy>
              {Object.keys(ABOUT).map((id) => (
                <li key={id} className="acc-media-skeleton" aria-hidden>
                  <div className="acc-media-top">
                    <i className="sk sk-icon" />
                    <i className="sk sk-vendor" />
                  </div>
                  <i className="sk sk-name" />
                  <i className="sk sk-line" />
                  <i className="sk sk-line is-short" />
                  <i className="sk sk-code" />
                </li>
              ))}
            </ul>
          )}
          {models && (
            <ul className="acc-media-grid" aria-label="Модели картинок">
              {models.models.map((m, i) => {
                const a = ABOUT[m.id];
                return (
                  <li key={m.id} className="acc-media-card" style={{ '--i': i } as CSSProperties}>
                    <div className="acc-media-top">
                      <VendorIcon vendor={a?.vendor ?? 'PurpleSchool'} />
                      <span className="muted">{a?.vendor ?? 'PurpleSchool'}</span>
                      {m.id === models.default && <span className="acc-media-default">по умолчанию</span>}
                    </div>
                    <strong>{a?.name ?? m.id}</strong>
                    {a?.use && <p>{a.use}</p>}
                    {m.price != null && <span className="acc-media-price">{credits(m.price)}</span>}
                    <code>{m.id}</code>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted acc-media-hint">Модель агент выбирает сам — или назовите её в просьбе. Не получилось — не списывается.</p>
        </>
      )}
    </div>
  );
}

/**
 * До входа: что даёт аккаунт для картинок. Ключа ещё нет — модели из справочника выше, без цен; после входа список
 * приходит от сервера (MediaModels).
 */
export function MediaPromo() {
  return (
    <section className="acc-media-promo" aria-label="Картинки после входа">
      <div className="acc-media-promo-head">
        <span className="acc-media-promo-icon">
          <ImageIcon size={16} />
        </span>
        <div>
          <strong>С подпиской агент рисует картинки</strong>
          <p>
            Войдите, оформите подписку или пакет PurpleSchool — и попросите в чате «нарисуй иконку для кнопки оплаты»: агент выберет модель,
            нарисует и покажет картинку в ответе.
          </p>
        </div>
      </div>
      <ul className="acc-media-promo-list" aria-label="Модели картинок">
        {Object.entries(ABOUT).map(([id, a]) => (
          <li key={id} title={a.use}>
            <VendorIcon vendor={a.vendor} size="s" />
            <span className="acc-media-promo-text">
              <strong>{a.name}</strong>
              <span>{a.vendor}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="acc-media-promo-soon">
        <Clapperboard size={13} /> Видео и <AudioLines size={13} /> озвучка — скоро
      </p>
    </section>
  );
}
