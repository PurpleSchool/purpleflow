import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, FolderSearch, KeyRound, PlugZap, RefreshCw, XCircle } from 'lucide-react';
import type { ConnectionCheck, Role, ToolName } from '@psflow/core';
import { Button, Field, Input, Topbar } from '../components/ui';
import { PillTabs } from '../components/PillTabs';

type SettingsTab = 'tools' | 'models' | 'window';
import { useStore } from '../lib/store';
import { Mark } from '../components/Sidebar';
import { shortPath } from '../lib/format';

/** Где взять токен PurpleSchool. */
const TOKEN_URL = 'https://app.purpleschool.ru/ai-for-code';

const TOOL_INFO: Record<ToolName, { title: string; install: string }> = {
  git: { title: 'Git', install: 'git-scm.com' },
  claude: { title: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { title: 'Codex CLI', install: 'npm i -g @openai/codex' },
  openspec: { title: 'OpenSpec', install: 'npm i -g @fission-ai/openspec' },
};

const ROLES: { id: Role; title: string; agent: string; text: string; placeholder: string }[] = [
  { id: 'planner', title: 'Планировщик', agent: 'claude', text: 'Пишет proposal, tasks и дельты спецификаций', placeholder: 'opus' },
  { id: 'executor', title: 'Исполнитель', agent: 'claude', text: 'Реализует tasks.md и пишет тесты', placeholder: 'sonnet' },
  { id: 'reviewer', title: 'Ревьюер', agent: 'codex', text: 'Сверяет дифф с планом, другая модель', placeholder: 'по умолчанию codex' },
];

export function SettingsScreen() {
  const { state, saveSettings, refreshTools, go } = useStore();
  const s = state.settings;
  const [key, setKey] = useState('');
  const [models, setModels] = useState<Record<Role, string>>({ planner: '', executor: '', reviewer: '' });
  const [paths, setPaths] = useState<Partial<Record<ToolName, string>>>({});
  const [agentTimeout, setAgentTimeout] = useState(30);
  const [testTimeout, setTestTimeout] = useState(10);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<ConnectionCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>('tools');

  useEffect(() => {
    if (!s) return;
    setModels(s.models);
    setPaths(s.toolPaths);
    setAgentTimeout(s.agentTimeoutMin);
    setTestTimeout(s.testTimeoutMin);
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
        toolPaths: paths,
        agentTimeoutMin: agentTimeout,
        testTimeoutMin: testTimeout,
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
  const allFound = tools && (['git', 'claude', 'codex', 'openspec'] as ToolName[]).every((t) => tools[t].path && !tools[t].error);

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
                return (
                  <div key={t} className={`tool ${!info ? 'is-loading' : ok ? 'is-ok' : 'is-bad'}`}>
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
                          {info.error}. Установка: <code>{TOOL_INFO[t].install}</code>
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
                <h2>Модели по ролям</h2>
                <p>Имя модели передаётся агенту как есть. Пусто — модель по умолчанию у CLI.</p>
              </div>
            </header>
            <div className="roles">
              {ROLES.map((r) => (
                <div key={r.id} className={`role bezel role-${r.agent}`}>
                  <div className="role-head">
                    <strong>{r.title}</strong>
                    <span className="role-agent">{r.agent}</span>
                  </div>
                  <p>{r.text}</p>
                  <Input mono placeholder={r.placeholder} value={models[r.id]} onChange={(e) => setModels({ ...models, [r.id]: e.target.value })} />
                </div>
              ))}
            </div>
            <div className="grid-2 narrow">
              <Field label="Таймаут стадии агента, мин">
                <Input type="number" min={1} value={agentTimeout} onChange={(e) => setAgentTimeout(Number(e.target.value) || 30)} />
              </Field>
              <Field label="Таймаут тестов, мин">
                <Input type="number" min={1} value={testTimeout} onChange={(e) => setTestTimeout(Number(e.target.value) || 10)} />
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
