import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, FolderSearch, KeyRound, PlugZap, RefreshCw, XCircle } from 'lucide-react';
import type { AgentKind, ConnectionCheck, Models, Role, StorageItem, ToolName } from '@psflow/core';
import { Button, Field, Input, Topbar } from '../components/ui';
import { PillTabs } from '../components/PillTabs';

type SettingsTab = 'tools' | 'models' | 'window';
import { useStore } from '../lib/store';
import { Mark } from '../components/Sidebar';
import { shortPath } from '../lib/format';
import { toolNeeded } from '../lib/tools';

/** Где взять токен PurpleSchool. */
const TOKEN_URL = 'https://app.purpleschool.ru/ai-for-code';

const TOOL_INFO: Record<ToolName, { title: string; install: string }> = {
  git: { title: 'Git', install: 'git-scm.com' },
  claude: { title: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { title: 'Codex CLI', install: 'npm i -g @openai/codex' },
  openspec: { title: 'OpenSpec', install: 'npm i -g @fission-ai/openspec' },
};

const ROLES: { id: Role; title: string; text: string }[] = [
  { id: 'planner', title: 'Планировщик', text: 'Пишет proposal, tasks и дельты спецификаций' },
  { id: 'executor', title: 'Исполнитель', text: 'Реализует tasks.md и пишет тесты' },
  { id: 'reviewer', title: 'Ревьюер', text: 'Сверяет дифф с планом — лучше другая модель, чем у исполнителя' },
];

/** Подсказки моделей: алиасы claude стабильны; для codex — пусто значит модель по умолчанию CLI. */
const MODEL_HINTS: Record<AgentKind, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: [] };
const MODEL_PLACEHOLDER: Record<AgentKind, string> = { claude: 'opus, sonnet, haiku или полное имя', codex: 'по умолчанию codex' };

export function SettingsScreen() {
  const { state, saveSettings, refreshTools, go } = useStore();
  const s = state.settings;
  const [key, setKey] = useState('');
  const [models, setModels] = useState<Models>({ planner: '', executor: '', reviewer: '', visual: '', manager: '' });
  const [agents, setAgents] = useState<Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind }>({ planner: 'claude', executor: 'claude', reviewer: 'codex' });
  const [paths, setPaths] = useState<Partial<Record<ToolName, string>>>({});
  const [agentTimeout, setAgentTimeout] = useState(30);
  const [testTimeout, setTestTimeout] = useState(10);
  const [parallel, setParallel] = useState(2);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<ConnectionCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>('tools');

  useEffect(() => {
    if (!s) return;
    setModels(s.models);
    setAgents(s.agents);
    setPaths(s.toolPaths);
    setAgentTimeout(s.agentTimeoutMin);
    setTestTimeout(s.testTimeoutMin);
    setParallel(s.maxParallel ?? 2);
  }, [s]);

  if (!s) return null;
  const first = !s.onboarded;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({
        ...(key ? { proxy: { apiKey: key.trim() } } : {}),
        models,
        agents,
        toolPaths: paths,
        agentTimeoutMin: agentTimeout,
        testTimeoutMin: testTimeout,
        maxParallel: parallel,
      });
      setKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      await refreshTools();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const check = async () => {
    await save();
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await window.psflow.core.testConnection());
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

  const tools = state.tools;
  const claudeFound = Boolean(tools?.claude.path && !tools.claude.error);
  const visualAgent = agents.visual ?? 'claude';
  const managerAgent = agents.manager ?? (tools && !claudeFound ? 'codex' : 'claude');
  const pickAgent = (id: Role | 'visual' | 'manager', a: AgentKind) => {
    if ((id === 'visual' ? visualAgent : id === 'manager' ? managerAgent : agents[id]) === a && (id !== 'manager' || agents.manager)) return;
    setAgents({ ...agents, [id]: a });
    // Имя модели одного CLI другому не подходит — сбрасываем на модель по умолчанию.
    setModels({ ...models, [id]: '' });
  };

  const allFound = tools && (['git', 'claude', 'codex', 'openspec'] as ToolName[]).every((t) => (tools[t].path && !tools[t].error) || !toolNeeded(t, agents));

  return (
    <div className="screen">
      {first ? (
        <div className="welcome drag">
          <Mark size={46} />
          <div>
            <h1>Настроим PurpleFlow</h1>
            <p>Задача пройдёт по стадиям: план, реализация, тесты, ревью другой моделью и ваша приёмка. Работают уже установленные claude и codex — нужно найти их и ввести токен PurpleSchool.</p>
          </div>
        </div>
      ) : (
        <Topbar title="Настройки" sub="Токен, инструменты, модели и вид приложения" />
      )}

      <div className="settings-tabs">
        <PillTabs<SettingsTab>
          className="tabs"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'tools', label: 'Инструменты', extra: tools && !allFound ? <span className="tab-badge b-coral">!</span> : undefined },
            { id: 'models', label: 'Модели' },
            { id: 'window', label: 'Приложение' },
          ]}
        />
      </div>

      <div className="scroll">
        <div className="settings tab-enter" key={tab}>
          {tab === 'tools' && (
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Токен PurpleSchool</h2>
                <p>С токеном приложение работает через ваш аккаунт PurpleSchool — без VPN. Без токена claude и codex работают по вашим обычным подпискам.</p>
              </div>
              <Button tone="ghost" icon={<PlugZap size={15} />} busy={checking} onClick={() => void check()}>
                Проверить подключение
              </Button>
            </header>
            <Field
              label="Токен"
              aside={
                s.proxy.hasKey && (
                  <span className="saved-key">
                    <KeyRound size={12} /> сохранён ·{' '}
                    <button className="link" onClick={() => void saveSettings({ proxy: { apiKey: '' } })}>удалить</button>
                  </span>
                )
              }
            >
              <div className="token-row">
                <Input
                  mono
                  type="password"
                  placeholder={s.proxy.hasKey ? '•••••••• оставьте пустым, чтобы не менять' : 'вставьте токен из аккаунта PurpleSchool'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <a className="btn btn-primary" href={TOKEN_URL} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} />
                  <span>Получить токен</span>
                </a>
              </div>
            </Field>
            {checks && (
              <div className="checks">
                {checks.map((c) => (
                  <div key={c.agent} className={`check ${c.ok ? 'is-ok' : 'is-bad'}`}>
                    {c.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                    <div>
                      <strong>{c.agent}</strong> <span className="muted mono">{c.model} · {(c.durationMs / 1000).toFixed(1)} с</span>
                      <p>{c.ok ? `Ответил: «${c.reply}»` : c.error}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          )}
          {tab === 'tools' && (
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Инструменты</h2>
                <p>Ищем в PATH вашего login-шелла. Если что-то не найдено, укажите путь вручную.</p>
              </div>
              <Button tone="quiet" icon={<RefreshCw size={14} />} busy={state.toolsLoading} onClick={() => void refreshTools()}>
                Проверить снова
              </Button>
            </header>
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
                        <span className="mono" title={info.path!}>{shortPath(info.path!)}</span>
                      ) : info ? (
                        <span className="tool-miss">
                          {info.error}.{needed ? '' : ' Не обязателен: ни одна роль на нём не работает.'} Установка: <code>{TOOL_INFO[t].install}</code>
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
                          const p = await window.psflow.pickFile();
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
                <p>Каждую роль может выполнять claude или codex. Имя модели передаётся выбранному CLI как есть, пусто — его модель по умолчанию. Служебные вызовы (сводка, профиль, уроки) — на claude, а если его нет — на codex. Новые настройки действуют на прогоны, запущенные после сохранения.</p>
              </div>
            </header>
            <div className="roles">
              {ROLES.map((r) => {
                const agent = agents[r.id];
                const sameAsExecutor = r.id === 'reviewer' && agent === agents.executor && models.reviewer.trim() === models.executor.trim();
                return (
                  <div key={r.id} className={`role bezel role-${agent}`}>
                    <div className="role-head">
                      <strong>{r.title}</strong>
                      <AgentSwitch label={r.title} value={agent} onChange={(a) => pickAgent(r.id, a)} />
                    </div>
                    <p>{r.text}</p>
                    {sameAsExecutor && <p className="role-warn">Совпадает с исполнителем — ревью той же моделью находит меньше.</p>}
                    <Input mono list={`models-${agent}`} placeholder={MODEL_PLACEHOLDER[agent]} value={models[r.id]} onChange={(e) => setModels({ ...models, [r.id]: e.target.value })} />
                  </div>
                );
              })}
              <div className={`role bezel role-${visualAgent}`}>
                <div className="role-head">
                  <strong>Визуальная проверка</strong>
                  <AgentSwitch label="Визуальная проверка" value={visualAgent} onChange={(a) => pickAgent('visual', a)} />
                </div>
                <p>Запускает приложение и проверяет результат в браузере через pw.{visualAgent === 'codex' ? ' На codex — без песочницы: браузеру нужны сеть и запись вне проекта, код он не меняет по инструкции.' : ''} Пусто — модель исполнителя, если он на том же агенте.</p>
                <Input mono list={`models-${visualAgent}`} placeholder={agents.executor === visualAgent && models.executor ? `как у исполнителя: ${models.executor}` : MODEL_PLACEHOLDER[visualAgent]} value={models.visual ?? ''} onChange={(e) => setModels({ ...models, visual: e.target.value })} />
              </div>
              <div className={`role bezel role-${managerAgent}`}>
                <div className="role-head">
                  <strong>Менеджер прогона</strong>
                  <AgentSwitch label="Менеджер прогона" value={managerAgent} onChange={(a) => pickAgent('manager', a)} />
                </div>
                <p>Отвечает в чате прогона, как идут дела, и предлагает поправить ход работы. Хватит быстрой модели.{agents.manager ? '' : ' Пока не выбран — claude, если он установлен, иначе codex.'} Пусто — модель первой роли на том же агенте.</p>
                <Input mono list={`models-${managerAgent}`} placeholder={MODEL_PLACEHOLDER[managerAgent]} value={models.manager ?? ''} onChange={(e) => setModels({ ...models, manager: e.target.value })} />
              </div>
              {(Object.keys(MODEL_HINTS) as AgentKind[]).map((a) => (
                <datalist key={a} id={`models-${a}`}>{MODEL_HINTS[a].map((m) => <option key={m} value={m} />)}</datalist>
              ))}
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
              <Field label="Агент молчит дольше, мин" hint="Столько без вывода — агент считается зависшим и останавливается. Долгую работу не обрывает: после этого времени покажем предупреждение, предел — ×4.">
                <Input type="number" min={1} value={agentTimeout} onChange={(e) => setAgentTimeout(Number(e.target.value) || 30)} />
              </Field>
              <Field label="Таймаут тестов, мин">
                <Input type="number" min={1} value={testTimeout} onChange={(e) => setTestTimeout(Number(e.target.value) || 10)} />
              </Field>
              <Field label="Одновременно прогонов" hint="Остальные ждут в очереди. Ожидание вашего решения место не занимает.">
                <Input type="number" min={1} max={8} value={parallel} onChange={(e) => setParallel(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
              </Field>
            </div>
          </section>
          )}
          {tab === 'window' && (
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Приложение</h2>
                <p>Прозрачный фон: сквозь окно размыто виден рабочий стол. Работает на macOS и Windows 11, на Windows 10 и Linux окно остаётся непрозрачным.</p>
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
                <p>Когда прогону нужно ваше решение (план, приёмка, исчерпанные попытки), он готов или остановился с ошибкой. Если окно в фокусе — только звук; если свёрнуто или в фоне — системное уведомление, клик по нему открывает прогон. Число прогонов, ждущих решения, — на значке в доке.</p>
              </div>
              <Button tone="quiet" onClick={() => void window.psflow.testNotification()}>Проверить</Button>
            </header>
            <div className="notify-toggles">
              {([
                { key: 'notify', label: 'Системные уведомления' },
                { key: 'sound', label: 'Звук' },
              ] as const).map((t) => (
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

      <footer className="actionbar">
        {error && <span className="actionbar-error">{error}</span>}
        {saved && <span className="actionbar-ok">Сохранено</span>}
        <span className="grow" />
        {first ? (
          <Button tone="primary" busy={saving} onClick={() => void finish()}>
            {allFound ? 'Готово, к задаче' : 'Сохранить и продолжить'}
          </Button>
        ) : (
          <Button tone="primary" busy={saving} onClick={() => void save()}>Сохранить</Button>
        )}
      </footer>
    </div>
  );
}

const bytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`
  : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} МБ`
  : n >= 1024 ? `${Math.round(n / 1024)} КБ`
  : n > 0 ? `${n} Б` : '—';

type Row = StorageItem;

/** Что PurpleFlow хранит в профиле пользователя и что из этого можно удалить. */
function StoragePanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [freed, setFreed] = useState<{ id: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, cache] = await Promise.all([window.psflow.core.getStorage(), window.psflow.appCache.size()]);
      setRows([...items, { id: 'app-cache', title: 'Кэш приложения', hint: 'Кэш Chromium: загруженные ресурсы, скомпилированный код, данные сайтов во вкладке «Браузер». Восстановится сам.', bytes: cache, count: 0, clean: 'Очистить' }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const clean = async (id: Row['id']) => {
    if (confirm !== id) return setConfirm(id);
    setConfirm(null);
    setBusy(id);
    setError(null);
    try {
      const before = rows?.find((r) => r.id === id)?.bytes ?? 0;
      let n: number;
      if (id === 'app-cache') {
        await window.psflow.appCache.clear();
        n = Math.max(0, before - (await window.psflow.appCache.size()));
      } else n = await window.psflow.core.cleanStorage(id);
      setFreed({ id, bytes: n });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const total = rows?.reduce((n, r) => n + r.bytes, 0) ?? 0;
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Хранилище{rows ? ` · ${bytes(total)}` : ''}</h2>
          <p>Что PurpleFlow хранит в профиле пользователя. Ваши проекты и ветки с результатами здесь не учитываются и не удаляются.</p>
        </div>
        <Button tone="quiet" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>Пересчитать</Button>
      </header>
      {error && <p className="inline-error">{error}</p>}
      {!rows ? (
        <div className="center storage-loading"><span className="spinner big" /></div>
      ) : (
        <div className="storage">
          {rows.map((r) => (
            <div key={r.id} className={`storage-row ${r.bytes ? '' : 'is-empty'}`}>
              <div className="storage-text">
                <strong>{r.title}{r.count ? <span className="muted"> · {r.count}</span> : null}</strong>
                <span>{r.hint}</span>
              </div>
              <span className="storage-size">{bytes(r.bytes)}</span>
              <div className="storage-action">
                {freed?.id === r.id && <span className="storage-freed">−{bytes(freed.bytes)}</span>}
                {r.clean && (
                  <Button
                    tone={confirm === r.id ? 'danger' : 'quiet'}
                    busy={busy === r.id}
                    disabled={!r.bytes || (busy !== null && busy !== r.id)}
                    onClick={() => void clean(r.id)}
                    onBlur={() => confirm === r.id && setTimeout(() => setConfirm(null), 150)}
                  >
                    {confirm === r.id ? 'Точно удалить?' : r.clean}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Выбор CLI-агента для роли. */
function AgentSwitch({ label, value, onChange }: { label: string; value: AgentKind; onChange: (a: AgentKind) => void }) {
  return (
    <div className="segmented small" role="radiogroup" aria-label={`Агент: ${label}`}>
      {(['claude', 'codex'] as AgentKind[]).map((a) => (
        <button key={a} role="radio" aria-checked={value === a} className={value === a ? 'is-on' : ''} onClick={() => onChange(a)}>
          {a}
        </button>
      ))}
    </div>
  );
}
