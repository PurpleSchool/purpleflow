import { useEffect, useState } from 'react';
import { CheckCircle2, FolderSearch, KeyRound, PlugZap, RefreshCw, XCircle } from 'lucide-react';
import type { ConnectionCheck, Role, ToolName } from '@psflow/core';
import { Button, Field, Input, Topbar } from '../components/ui';
import { useStore } from '../lib/store';
import { Mark } from '../components/Sidebar';
import { shortPath } from '../lib/format';

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
  const [baseUrl, setBaseUrl] = useState('');
  const [codexUrl, setCodexUrl] = useState('');
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
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!s) return;
    setBaseUrl(s.proxy.baseUrl);
    setCodexUrl(s.proxy.codexBaseUrl);
    setModels(s.models);
    setPaths(s.toolPaths);
    setAgentTimeout(s.agentTimeoutMin);
    setTestTimeout(s.testTimeoutMin);
    if (s.proxy.codexBaseUrl) setAdvanced(true);
  }, [s]);

  if (!s) return null;
  const first = !s.onboarded;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({
        proxy: { baseUrl: baseUrl.trim(), codexBaseUrl: codexUrl.trim(), ...(key ? { apiKey: key.trim() } : {}) },
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
            <h1>Настроим PS Flow</h1>
            <p>Задача пройдёт по стадиям: план, реализация, тесты, ревью другой моделью и ваша приёмка. Работают уже установленные claude и codex — нужно найти их и подключить прокси.</p>
          </div>
        </div>
      ) : (
        <Topbar title="Настройки" sub="Инструменты, прокси и модели по ролям" />
      )}

      <div className="scroll">
        <div className="settings">
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
            <div className="tools">
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

          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Прокси PurpleSchool</h2>
                <p>Передаётся агентам только через переменные окружения процесса. Файлы ~/.claude и ~/.codex не меняются. Пустой адрес — агенты используют свою авторизацию.</p>
              </div>
            </header>
            <div className="grid-2">
              <Field label="Base URL">
                <Input mono placeholder="https://proxy.purpleschool.ru" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </Field>
              <Field
                label="Ключ"
                aside={s.proxy.hasKey && <span className="saved-key"><KeyRound size={12} /> сохранён в связке ключей</span>}
              >
                <Input
                  mono
                  type="password"
                  placeholder={s.proxy.hasKey ? '•••••••• оставьте пустым, чтобы не менять' : 'ps-…'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
            </div>
            <button className="disclosure" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              {advanced ? 'Скрыть' : 'Отдельный адрес для codex'}
            </button>
            {advanced && (
              <Field label="Base URL для codex (OpenAI Responses API)" hint="Если пусто — используется Base URL + /v1">
                <Input mono placeholder="https://proxy.purpleschool.ru/openai/v1" value={codexUrl} onChange={(e) => setCodexUrl(e.target.value)} />
              </Field>
            )}
          </section>

          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Модели по ролям</h2>
                <p>Имя модели передаётся агенту как есть. Пусто — модель по умолчанию у CLI.</p>
              </div>
            </header>
            <div className="roles">
              {ROLES.map((r) => (
                <div key={r.id} className={`role role-${r.agent}`}>
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

          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Подключение</h2>
                <p>Короткий тестовый запрос каждым агентом с текущими настройками.</p>
              </div>
              <Button tone="ghost" icon={<PlugZap size={15} />} busy={checking} onClick={() => void check()}>
                Проверить подключение
              </Button>
            </header>
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
