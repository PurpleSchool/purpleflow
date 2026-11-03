// Вкладка «Инструменты»: найденные git, claude, codex, openspec и пути к ним.
import type { ToolName } from '@purpleflow/core';
import { FolderSearch, RefreshCw, Wand2 } from 'lucide-react';
import { Button, Input } from '../../components/ui';
import { bridge } from '../../lib/api';
import { shortPath } from '../../lib/format';
import { useStore } from '../../lib/store';
import { toolNeeded } from '../../lib/tools';
import { CheckButton, ChecksList, TOOL_INFO } from './parts';
import type { SettingsDraft } from './useSettingsDraft';
import type { ToolSetup } from './useToolSetup';

export function ToolsTab({ draft, setup }: { draft: SettingsDraft; setup: ToolSetup }) {
  const { state, refreshTools } = useStore();
  const s = state.settings!;
  const tools = state.tools;
  const { paths, setPaths, agents, checks } = draft;
  const proxyOn = s.proxy.hasKey && s.proxy.enabled;
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Инструменты</h2>
          <p>
            Ищем в PATH вашего login-шелла. Если что-то не найдено, укажите путь вручную. «Проверить подключение» отправит агентам короткий
            запрос —{' '}
            {proxyOn ? (s.accountEnabled ? 'через AI-прокси PurpleSchool' : 'через AI-прокси') : 'по вашим подпискам claude и codex'}.
          </p>
        </div>
        <div className="panel-actions">
          <Button tone="quiet" icon={<RefreshCw size={14} />} busy={state.toolsLoading} onClick={() => void refreshTools()}>
            Найти снова
          </Button>
          {setup.missing.length > 0 ? (
            <Button tone="primary" icon={<Wand2 size={15} />} busy={setup.running} onClick={() => void setup.run()}>
              Настроить
            </Button>
          ) : (
            <CheckButton draft={draft} />
          )}
        </div>
      </header>
      {checks && <ChecksList checks={checks} />}
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
                ) : setup.current === t ? (
                  <span>Устанавливаю…</span>
                ) : setup.errors[t] ? (
                  <span className="tool-miss">{setup.errors[t]}</span>
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
  );
}
