// Вкладка «Приложение»: прозрачность окна, уведомления, обновления и место на диске.
import { Button } from '../../components/ui';
import { bridge } from '../../lib/api';
import { useStore } from '../../lib/store';
import { StoragePanel } from './StoragePanel';

export function AppTab() {
  const { state, saveSettings } = useStore();
  const s = state.settings!;
  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Приложение</h2>
            <p>
              Прозрачный фон: сквозь окно размыто виден рабочий стол. Работает на macOS и Windows 11, на Windows 10 и Linux окно остаётся
              непрозрачным.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={s.windowGlass}
            className={`switch ${s.windowGlass ? 'is-on' : ''}`}
            onClick={() => void saveSettings({ windowGlass: !s.windowGlass })}
          >
            <i />
            <span>{s.windowGlass ? 'Прозрачное' : 'Непрозрачное'}</span>
          </button>
        </header>
      </section>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Уведомления</h2>
            <p>
              Когда прогону нужно ваше решение (план, приёмка, исчерпанные попытки), он готов или остановился с ошибкой. Если окно в фокусе
              — только звук; если свёрнуто или в фоне — системное уведомление, клик по нему открывает прогон. Число прогонов, ждущих
              решения, — на значке в доке.
            </p>
          </div>
          <Button tone="quiet" onClick={() => void bridge.testNotification()}>
            Проверить
          </Button>
        </header>
        <div className="notify-toggles">
          {(
            [
              { key: 'notify', label: 'Системные уведомления' },
              { key: 'sound', label: 'Звук' },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              role="switch"
              aria-checked={s[t.key]}
              className={`switch ${s[t.key] ? 'is-on' : ''}`}
              onClick={() => void saveSettings({ [t.key]: !s[t.key] })}
            >
              <i />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Обновления</h2>
            <p>Приложение само проверяет новые версии при запуске и раз в 6 часов. Скачивание и перезапуск — только по вашей кнопке.</p>
          </div>
          <Button tone="quiet" onClick={() => void bridge.update.check()}>
            Проверить обновления
          </Button>
        </header>
      </section>
      <StoragePanel />
    </>
  );
}
