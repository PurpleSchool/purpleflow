// Карточка под ответом чата, когда картинку не нарисовать: нет подписки или токенов (subscribe), не выполнен вход в
// PurpleSchool (signup) или картинки выключены в настройках (enable).
import { useState } from 'react';
import { CreditCard, ImagePlus, LogIn } from 'lucide-react';
import type { ChatOfferPart } from '@purpleflow/core';
import { useStore } from '../lib/store';
import { PLANS_URL } from './AccountStats';
import { Button } from './ui';

export function MediaOfferCard({ offer }: { offer: ChatOfferPart['offer'] }) {
  const { go, saveSettings, state } = useStore();
  const [enabled, setEnabled] = useState(false);
  if (offer === 'subscribe')
    return (
      <div className="chat-banner chat-offer">
        <CreditCard size={16} />
        <div className="chat-banner-text">
          <strong>Нужна подписка PurpleSchool</strong>
          <p>Картинки рисуются за подписку или пакет: на балансе не хватило токенов или их нет. Неудачная генерация не списывается.</p>
        </div>
        <a className="btn btn-primary" href={PLANS_URL} target="_blank" rel="noreferrer">
          Оформить подписку
        </a>
      </div>
    );
  if (offer === 'signup')
    return (
      <div className="chat-banner chat-offer">
        <LogIn size={16} />
        <div className="chat-banner-text">
          <strong>Войдите в PurpleSchool, чтобы агент рисовал картинки</strong>
          <p>Агент рисует через сервис PurpleSchool — по подписке или пакету. Войдите или зарегистрируйтесь — и повторите просьбу.</p>
        </div>
        <Button tone="primary" onClick={() => go({ name: 'settings', tab: 'account' })}>
          Войти или зарегистрироваться
        </Button>
      </div>
    );
  const on = enabled || state.settings?.media.enabled;
  return (
    <div className="chat-banner chat-offer">
      <ImagePlus size={16} />
      <div className="chat-banner-text">
        <strong>{on ? 'Картинки включены' : 'Картинки выключены'}</strong>
        <p>{on ? 'Повторите просьбу — агент нарисует картинку.' : 'Включите их — и агент сможет рисовать по вашей просьбе.'}</p>
      </div>
      {!on && (
        <Button
          tone="primary"
          onClick={() => {
            setEnabled(true);
            void saveSettings({ media: { enabled: true } });
          }}
        >
          Включить картинки
        </Button>
      )}
    </div>
  );
}
