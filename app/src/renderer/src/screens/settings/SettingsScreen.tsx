// Настройки: вкладки аккаунта, расхода, инструментов, моделей и приложения; черновик правок — в useSettingsDraft.
import { useEffect, useState } from 'react';
import { AccountStats } from '../../components/AccountStats';
import { PillTabs } from '../../components/PillTabs';
import { Mark } from '../../components/Sidebar';
import { Button, Topbar } from '../../components/ui';
import { bridge } from '../../lib/api';
import { useStore } from '../../lib/store';
import { AccountTab } from './AccountTab';
import { AppTab } from './AppTab';
import { ModelsTab } from './ModelsTab';
import { SetupDialog } from './SetupDialog';
import { ToolsTab } from './ToolsTab';
import { useSettingsDraft } from './useSettingsDraft';
import { useToolSetup } from './useToolSetup';

type SettingsTab = 'account' | 'stats' | 'tools' | 'models' | 'window';
export function SettingsScreen() {
  const { state, saveSettings, reloadSettings, go } = useStore();
  const s = state.settings;
  const draft = useSettingsDraft();
  const { saving, saved, error, save, allFound } = draft;
  const setup = useToolSetup(draft);
  const [setupClosed, setSetupClosed] = useState(false);
  // Первый запуск идёт после экрана входа — начинаем с инструментов; дальше первой открывается вкладка аккаунта.
  const [tab, setTab] = useState<SettingsTab>(() => (s && (!s.onboarded || !s.accountEnabled) ? 'tools' : 'account'));

  // Имя и аватар могли поменяться на сайте — обновляем при открытии вкладки аккаунта.
  const accountEmail = s?.account?.email;
  useEffect(() => {
    if (tab !== 'account' || !accountEmail) return;
    void bridge.account.profile().then((r) => {
      if (r.ok || r.code === 'unauthorized') void reloadSettings();
    });
  }, [tab, accountEmail, reloadSettings]);

  if (!s) return null;
  const first = !s.onboarded;
  const tools = state.tools;

  const finish = async () => {
    await save();
    await saveSettings({ onboarded: true });
    // Проектов ещё нет — ведём к первому: выбор папки, сканирование, подключение.
    const projects = await bridge.core.listProjects().catch(() => null);
    go(projects && projects.length === 0 ? { name: 'start' } : { name: 'new' });
  };

  return (
    <div className="screen">
      {first ? (
        <div className="welcome drag">
          <Mark size={46} />
          <div>
            <h1>Настроим PurpleFlow</h1>
            <p>
              Задача пройдёт по стадиям: план, реализация, тесты, ревью другой моделью и ваша приёмка. Работают уже установленные claude и
              codex — проверим, что они найдены, и выберем модели.
            </p>
            <p>
              Мы получаем анонимную статистику шагов и отчёты об ошибках — без кода, задач и путей к проектам. Отключить можно на вкладке
              «Приложение».
            </p>
          </div>
        </div>
      ) : (
        <Topbar
          title="Настройки"
          sub={s.accountEnabled ? 'Аккаунт, статистика, инструменты, модели и вид приложения' : 'Инструменты, модели и вид приложения'}
        />
      )}

      <div className="settings-tabs">
        <PillTabs<SettingsTab>
          className="tabs"
          value={tab}
          onChange={setTab}
          items={[
            ...(s.accountEnabled
              ? [
                  { id: 'account' as const, label: 'Аккаунт' },
                  { id: 'stats' as const, label: 'Статистика' },
                ]
              : []),
            { id: 'tools', label: 'Инструменты', extra: tools && !allFound ? <span className="tab-badge b-coral">!</span> : undefined },
            { id: 'models', label: 'Модели' },
            { id: 'window', label: 'Приложение' },
          ]}
        />
      </div>

      <div className="scroll">
        <div className="settings tab-enter" key={tab}>
          {tab === 'account' && <AccountTab draft={draft} />}
          {tab === 'stats' && <AccountStats onSignIn={() => setTab('account')} />}
          {tab === 'tools' && <ToolsTab draft={draft} setup={setup} />}
          {tab === 'models' && <ModelsTab draft={draft} />}
          {tab === 'window' && <AppTab />}
        </div>
      </div>

      {/* На «Аккаунте» и «Статистике» всё применяется сразу — сохранять нечего. */}
      {(first || (tab !== 'account' && tab !== 'stats')) && (
        <footer className="actionbar">
          {error && <span className="actionbar-error">{error}</span>}
          {saved && <span className="actionbar-ok">Сохранено</span>}
          <span className="grow" />
          {first ? (
            <Button tone="primary" busy={saving} onClick={() => void finish()}>
              {allFound ? 'Готово, к задаче' : 'Сохранить и продолжить'}
            </Button>
          ) : (
            <Button tone="primary" busy={saving} onClick={() => void save()}>
              Сохранить
            </Button>
          )}
        </footer>
      )}

      {first && !setupClosed && (
        <SetupDialog draft={draft} setup={setup} onClose={() => setSetupClosed(true)} onFinish={() => void finish()} />
      )}
    </div>
  );
}
