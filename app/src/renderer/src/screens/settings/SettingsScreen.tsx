// Настройки: аккаунт PurpleSchool, расход, инструменты, модели и агенты по ролям, окно и место на диске.
import type { AgentKind, ConnectionCheck, Models, Role, ToolName } from '@purpleflow/core';
import { Check, CheckCircle2, FolderSearch, KeyRound, LogOut, PlugZap, RefreshCw, Wand2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PillTabs } from '../../components/PillTabs';
import { Button, Field, Input, Topbar } from '../../components/ui';
import { ACCOUNT_BENEFITS, AccountKeys, AuthForms } from '../../components/Account';
import { AccountStats } from '../../components/AccountStats';
import { ComboInput } from '../../components/Dropdown';
import { QuickSetup } from '../../components/QuickSetup';
import { Mark } from '../../components/Sidebar';
import { shortPath } from '../../lib/format';
import { MODEL_OPTIONS } from '../../lib/models';
import { useStore } from '../../lib/store';
import { toolNeeded } from '../../lib/tools';
import { StoragePanel } from './StoragePanel';
import { AgentSwitch, MODEL_PLACEHOLDER, ROLES, TOOL_INFO } from './parts';
import { bridge } from '../../lib/api';

type SettingsTab = 'account' | 'stats' | 'tools' | 'models' | 'window';
export function SettingsScreen() {
  const { state, saveSettings, reloadSettings, refreshTools, go } = useStore();
  const s = state.settings;
  const [models, setModels] = useState<Models>({ planner: '', executor: '', reviewer: '', visual: '', manager: '' });
  const [agents, setAgents] = useState<Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind }>({
    planner: 'claude',
    executor: 'claude',
    reviewer: 'codex',
  });
  const [paths, setPaths] = useState<Partial<Record<ToolName, string>>>({});
  const [agentTimeout, setAgentTimeout] = useState(30);
  const [testTimeout, setTestTimeout] = useState(10);
  const [parallel, setParallel] = useState(2);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<ConnectionCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  // Первый запуск идёт после экрана входа — начинаем с инструментов; дальше первой открывается вкладка аккаунта.
  const [tab, setTab] = useState<SettingsTab>(() => (s && !s.onboarded ? 'tools' : 'account'));

  useEffect(() => {
    if (!s) return;
    setModels(s.models);
    setAgents(s.agents);
    setPaths(s.toolPaths);
    setAgentTimeout(s.agentTimeoutMin);
    setTestTimeout(s.testTimeoutMin);
    setParallel(s.maxParallel ?? 2);
  }, [s]);

  // Имя и аватар могли поменяться на сайте — обновляем при открытии вкладки аккаунта.
  const accountEmail = s?.account?.email;
  useEffect(() => {
    if (tab !== 'account' || !accountEmail) return;
    void bridge.account.profile().then((r) => {
      if (r.ok || r.code === 'unauthorized') void reloadSettings();
    });
  }, [tab, accountEmail]);

  if (!s) return null;
  const first = !s.onboarded;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({
        models,
        agents,
        toolPaths: paths,
        agentTimeoutMin: agentTimeout,
        testTimeoutMin: testTimeout,
        maxParallel: parallel,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      await refreshTools();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Выход удаляет токен аккаунта; ключ прокси остаётся — его можно удалить отдельно. */
  const logout = async () => {
    await bridge.account.logout();
    await reloadSettings();
    setChecks(null);
  };

  const check = async () => {
    await save();
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await bridge.core.testConnection());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const finish = async () => {
    await save();
    await saveSettings({ onboarded: true });
    go({ name: 'new' });
  };

  const checkButton = (
    <Button tone="ghost" icon={<PlugZap size={15} />} busy={checking} onClick={() => void check()}>
      Проверить подключение
    </Button>
  );
  const checksView = (
    <div className="checks">
      {checks?.map((c) => (
        <div key={c.agent} className={`check ${c.ok ? 'is-ok' : 'is-bad'}`}>
          {c.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div>
            <strong>{c.agent}</strong>{' '}
            <span className="muted mono">
              {c.model} · {(c.durationMs / 1000).toFixed(1)} с
            </span>
            <p>{c.ok ? `Ответил: «${c.reply}»` : c.error}</p>
          </div>
        </div>
      ))}
    </div>
  );
  /** Через прокси проверять имеет смысл только с включённым ключом; без него — агентов на вкладке «Инструменты». */
  const proxyOn = s.proxy.hasKey && s.proxy.enabled;

  const tools = state.tools;
  const claudeFound = Boolean(tools?.claude.path && !tools.claude.error);
  const visualAgent = agents.visual ?? 'claude';
  const managerAgent = agents.manager ?? (tools && !claudeFound ? 'codex' : 'claude');
  const pickAgent = (id: Role | 'visual' | 'manager', a: AgentKind) => {
    if ((id === 'visual' ? visualAgent : id === 'manager' ? managerAgent : agents[id]) === a && (id !== 'manager' || agents.manager))
      return;
    setAgents({ ...agents, [id]: a });
    // Имя модели одного CLI другому не подходит — сбрасываем на модель по умолчанию.
    setModels({ ...models, [id]: '' });
  };

  const allFound =
    tools &&
    (['git', 'claude', 'codex', 'openspec'] as ToolName[]).every((t) => (tools[t].path && !tools[t].error) || !toolNeeded(t, agents));

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
          </div>
        </div>
      ) : (
        <Topbar title="Настройки" sub="Аккаунт, статистика, инструменты, модели и вид приложения" />
      )}

      <div className="settings-tabs">
        <PillTabs<SettingsTab>
          className="tabs"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'account', label: 'Аккаунт' },
            { id: 'stats', label: 'Статистика' },
            { id: 'tools', label: 'Инструменты', extra: tools && !allFound ? <span className="tab-badge b-coral">!</span> : undefined },
            { id: 'models', label: 'Модели' },
            { id: 'window', label: 'Приложение' },
          ]}
        />
      </div>

      <div className="scroll">
        <div className="settings tab-enter" key={tab}>
          {tab === 'account' && (
            <section className="panel">
              {s.account ? (
                <>
                  <header className="panel-head">
                    <div>
                      <h2>Аккаунт PurpleSchool</h2>
                      <p>
                        Агенты работают через AI-прокси PurpleSchool по ключу вашего аккаунта — без VPN. Без ключа claude и codex работают
                        по вашим обычным подпискам.
                      </p>
                    </div>
                    {proxyOn && checkButton}
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
                    {s.proxy.hasKey && (
                      <div className={`acc-proxy ${s.proxy.enabled ? 'is-on' : ''}`}>
                        <div className="acc-proxy-text">
                          <strong>
                            Работать через PurpleSchool <span className="acc-state">{s.proxy.enabled ? 'включено' : 'выключено'}</span>
                          </strong>
                          <span>
                            {s.proxy.enabled
                              ? 'claude и codex ходят в модели по ключу ниже — без VPN, расход идёт с баланса аккаунта.'
                              : 'Ключ сохранён, но не используется: claude и codex работают по вашим обычным подпискам.'}
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
                        <p>
                          Войдите или зарегистрируйтесь, чтобы claude и codex работали через AI-прокси PurpleSchool — без VPN, с оплатой в
                          рублях. Без этого они работают по вашим обычным подпискам.
                        </p>
                      </div>
                    </header>
                    <ul className="acc-benefits">
                      {ACCOUNT_BENEFITS.map((b) => (
                        <li key={b.title}>
                          <Check size={13} />
                          <div>
                            <strong>{b.title}</strong>
                            <span>{b.text}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="acc-form bezel">
                    <AuthForms onDone={() => undefined} />
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
                      : 'Ключ сохранён, но не используется: claude и codex работают по вашим обычным подпискам. Аккаунт остаётся подключённым.'}
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
              {checks && checksView}
            </section>
          )}
          {tab === 'stats' && <AccountStats onSignIn={() => setTab('account')} />}
          {tab === 'tools' && (
            <section className="panel">
              <header className="panel-head">
                <div>
                  <h2>Инструменты</h2>
                  <p>
                    Ищем в PATH вашего login-шелла. Если что-то не найдено, укажите путь вручную. «Проверить подключение» отправит агентам
                    короткий запрос — {proxyOn ? 'через AI-прокси PurpleSchool' : 'по вашим подпискам claude и codex'}.
                  </p>
                </div>
                <div className="panel-actions">
                  <Button tone="quiet" icon={<RefreshCw size={14} />} busy={state.toolsLoading} onClick={() => void refreshTools()}>
                    Найти снова
                  </Button>
                  {checkButton}
                </div>
              </header>
              {checks && checksView}
              <div className="tools bezel">
                {(['git', 'claude', 'codex', 'openspec'] as ToolName[]).map((t) => {
                  const info = tools?.[t];
                  const ok = info?.path && !info.error;
                  const needed = toolNeeded(t, agents);
                  return (
                    <div key={t} className={`tool ${!info ? 'is-loading' : ok ? 'is-ok' : needed ? 'is-bad' : 'is-off'}`}>
                      <span className="tool-led" />
                      <div className="tool-id">
                        <strong>{TOOL_INFO[t].title}</strong>
                        <span className="mono muted">{info?.version ?? (info ? '—' : 'ищем…')}</span>
                      </div>
                      <div className="tool-path">
                        {ok ? (
                          <span className="mono" title={info.path!}>
                            {shortPath(info.path!)}
                          </span>
                        ) : info ? (
                          <span className="tool-miss">
                            {info.error}.{needed ? '' : ' Не обязателен: ни одна роль на нём не работает.'} Установка:{' '}
                            <code>{TOOL_INFO[t].install}</code>
                          </span>
                        ) : null}
                      </div>
                      <div className="tool-manual">
                        <Input
                          mono
                          placeholder="путь вручную"
                          value={paths[t] ?? ''}
                          onChange={(e) => setPaths({ ...paths, [t]: e.target.value })}
                        />
                        <Button
                          tone="quiet"
                          title="Выбрать файл"
                          icon={<FolderSearch size={15} />}
                          onClick={async () => {
                            const p = await bridge.pickFile();
                            if (p) setPaths({ ...paths, [t]: p });
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {tab === 'models' && (
            <section className="panel">
              <header className="panel-head">
                <div>
                  <h2>Агенты и модели по ролям</h2>
                  <p>
                    Каждую роль может выполнять claude или codex. Имя модели передаётся выбранному CLI как есть, пусто — его модель по
                    умолчанию. Служебные вызовы (сводка, профиль, уроки) — на claude, а если его нет — на codex. Новые настройки действуют
                    на прогоны, запущенные после сохранения.
                  </p>
                </div>
                <Button tone="primary" icon={<Wand2 size={15} />} onClick={() => setQuick(true)}>
                  Быстрая настройка
                </Button>
              </header>
              {quick && (
                <QuickSetup
                  installed={{ claude: claudeFound, codex: Boolean(tools?.codex.path && !tools.codex.error) }}
                  initialMain={agents.executor}
                  onClose={() => setQuick(false)}
                  onApply={async (v) => {
                    setAgents(v.agents);
                    setModels(v.models);
                    await saveSettings({ agents: v.agents, models: v.models });
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1800);
                  }}
                />
              )}
              <div className="roles">
                {ROLES.map((r) => {
                  const agent = agents[r.id];
                  const sameAsExecutor =
                    r.id === 'reviewer' && agent === agents.executor && models.reviewer.trim() === models.executor.trim();
                  return (
                    <div key={r.id} className={`role bezel role-${agent}`}>
                      <div className="role-head">
                        <strong>{r.title}</strong>
                        <AgentSwitch label={r.title} value={agent} onChange={(a) => pickAgent(r.id, a)} />
                      </div>
                      <p>{r.text}</p>
                      {sameAsExecutor && <p className="role-warn">Совпадает с исполнителем — ревью той же моделью находит меньше.</p>}
                      <ComboInput
                        className="role-model"
                        ariaLabel={`Модель: ${r.title}`}
                        options={MODEL_OPTIONS[agent]}
                        placeholder={MODEL_PLACEHOLDER[agent]}
                        value={models[r.id]}
                        onChange={(v) => setModels({ ...models, [r.id]: v })}
                      />
                    </div>
                  );
                })}
                <div className={`role bezel role-${visualAgent}`}>
                  <div className="role-head">
                    <strong>Визуальная проверка</strong>
                    <AgentSwitch label="Визуальная проверка" value={visualAgent} onChange={(a) => pickAgent('visual', a)} />
                  </div>
                  <p>
                    Запускает приложение и проверяет результат в браузере через pw.
                    {visualAgent === 'codex'
                      ? ' На codex — без песочницы: браузеру нужны сеть и запись вне проекта, код он не меняет по инструкции.'
                      : ''}{' '}
                    Пусто — модель исполнителя, если он на том же агенте.
                  </p>
                  <ComboInput
                    className="role-model"
                    ariaLabel="Модель: визуальная проверка"
                    options={MODEL_OPTIONS[visualAgent]}
                    placeholder={
                      agents.executor === visualAgent && models.executor
                        ? `как у исполнителя: ${models.executor}`
                        : MODEL_PLACEHOLDER[visualAgent]
                    }
                    value={models.visual ?? ''}
                    onChange={(v) => setModels({ ...models, visual: v })}
                  />
                </div>
                <div className={`role bezel role-${managerAgent}`}>
                  <div className="role-head">
                    <strong>Менеджер прогона</strong>
                    <AgentSwitch label="Менеджер прогона" value={managerAgent} onChange={(a) => pickAgent('manager', a)} />
                  </div>
                  <p>
                    Отвечает в чате прогона, как идут дела, и предлагает поправить ход работы. Хватит быстрой модели.
                    {agents.manager ? '' : ' Пока не выбран — claude, если он установлен, иначе codex.'} Пусто — модель первой роли на том
                    же агенте.
                  </p>
                  <ComboInput
                    className="role-model"
                    ariaLabel="Модель: менеджер прогона"
                    options={MODEL_OPTIONS[managerAgent]}
                    placeholder={MODEL_PLACEHOLDER[managerAgent]}
                    value={models.manager ?? ''}
                    onChange={(v) => setModels({ ...models, manager: v })}
                  />
                </div>
              </div>
              <div className="user-config">
                <button
                  role="switch"
                  aria-checked={s.userConfig}
                  className={`switch ${s.userConfig ? 'is-on' : ''}`}
                  onClick={() => void saveSettings({ userConfig: !s.userConfig })}
                >
                  <i />
                  <span>Мои настройки агентов</span>
                </button>
                <p>
                  {s.userConfig
                    ? 'Агенты работают с вашими настройками из ~/.claude и ~/.codex: MCP-серверы, скиллы, плагины, CLAUDE.md — как в обычном claude и codex. Хуки claude в прогонах выключены. Файлы настроек PurpleFlow не меняет.'
                    : 'Агенты запускаются изолированно: только настройки самого проекта, без ваших MCP-серверов, скиллов, плагинов и хуков. Прогоны повторяемее, но, например, задачу из трекера через MCP агент не прочитает.'}
                </p>
              </div>
              <div className="grid-2 narrow">
                <Field
                  label="Агент молчит дольше, мин"
                  hint="Столько без вывода — агент считается зависшим и останавливается. Долгую работу не обрывает: после этого времени покажем предупреждение, предел — ×4."
                >
                  <Input type="number" min={1} value={agentTimeout} onChange={(e) => setAgentTimeout(Number(e.target.value) || 30)} />
                </Field>
                <Field label="Таймаут тестов, мин">
                  <Input type="number" min={1} value={testTimeout} onChange={(e) => setTestTimeout(Number(e.target.value) || 10)} />
                </Field>
                <Field label="Одновременно прогонов" hint="Остальные ждут в очереди. Ожидание вашего решения место не занимает.">
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={parallel}
                    onChange={(e) => setParallel(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                  />
                </Field>
              </div>
            </section>
          )}
          {tab === 'window' && (
            <section className="panel">
              <header className="panel-head">
                <div>
                  <h2>Приложение</h2>
                  <p>
                    Прозрачный фон: сквозь окно размыто виден рабочий стол. Работает на macOS и Windows 11, на Windows 10 и Linux окно
                    остаётся непрозрачным.
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
          )}
          {tab === 'window' && (
            <section className="panel">
              <header className="panel-head">
                <div>
                  <h2>Уведомления</h2>
                  <p>
                    Когда прогону нужно ваше решение (план, приёмка, исчерпанные попытки), он готов или остановился с ошибкой. Если окно в
                    фокусе — только звук; если свёрнуто или в фоне — системное уведомление, клик по нему открывает прогон. Число прогонов,
                    ждущих решения, — на значке в доке.
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
          )}
          {tab === 'window' && <StoragePanel />}
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
    </div>
  );
}
