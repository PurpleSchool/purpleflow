// Вкладка «Модели»: агент и модель для каждой роли, таймауты и параллельные прогоны.
import { Wand2 } from 'lucide-react';
import { useState } from 'react';
import { ModelInput } from '../../components/ModelInput';
import { QuickSetup } from '../../components/QuickSetup';
import { Button, Field, Input } from '../../components/ui';
import { useModelOptions } from '../../lib/useModelOptions';
import { useStore } from '../../lib/store';
import { AgentSwitch, MODEL_PLACEHOLDER, ROLES } from './parts';
import type { SettingsDraft } from './useSettingsDraft';

export function ModelsTab({ draft }: { draft: SettingsDraft }) {
  const { state, saveSettings } = useStore();
  const modelOptions = useModelOptions();
  const s = state.settings!;
  const tools = state.tools;
  const [quick, setQuick] = useState(false);
  const {
    models,
    setModels,
    agents,
    setAgents,
    pickAgent,
    visualAgent,
    managerAgent,
    scanAgent,
    claudeFound,
    flashSaved,
    agentTimeout,
    setAgentTimeout,
    testTimeout,
    setTestTimeout,
    parallel,
    setParallel,
  } = draft;
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Агенты и модели по ролям</h2>
          <p>
            Каждую роль может выполнять claude или codex. Имя модели передаётся выбранному CLI как есть, пусто — его модель по умолчанию.
            Служебные вызовы (сводка, уроки) — на claude, а если его нет — на codex. Новые настройки действуют на прогоны, запущенные после
            сохранения.
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
            flashSaved();
          }}
        />
      )}
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
              <ModelInput
                className="role-model"
                ariaLabel={`Модель: ${r.title}`}
                options={modelOptions[agent]}
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
          <ModelInput
            className="role-model"
            ariaLabel="Модель: визуальная проверка"
            options={modelOptions[visualAgent]}
            placeholder={
              agents.executor === visualAgent && models.executor ? `как у исполнителя: ${models.executor}` : MODEL_PLACEHOLDER[visualAgent]
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
            {agents.manager ? '' : ' Пока не выбран — claude, если он установлен, иначе codex.'} Пусто — модель первой роли на том же
            агенте.
          </p>
          <ModelInput
            className="role-model"
            ariaLabel="Модель: менеджер прогона"
            options={modelOptions[managerAgent]}
            placeholder={MODEL_PLACEHOLDER[managerAgent]}
            value={models.manager ?? ''}
            onChange={(v) => setModels({ ...models, manager: v })}
          />
        </div>
        <div className={`role bezel role-${scanAgent}`}>
          <div className="role-head">
            <strong>Сканирование проекта</strong>
            <AgentSwitch label="Сканирование проекта" value={scanAgent} onChange={(a) => pickAgent('scan', a)} />
          </div>
          <p>
            Находит команды проекта и собирает профиль — стек, структуру, соглашения. Только читает код.
            {agents.scan ? '' : ' Пока не выбран — claude, если он установлен, иначе codex.'} Если агент не вошёл в аккаунт или упал —
            сканирование повторит другой. Пусто — модель первой роли на том же агенте.
          </p>
          <ModelInput
            className="role-model"
            ariaLabel="Модель: сканирование проекта"
            options={modelOptions[scanAgent]}
            placeholder={MODEL_PLACEHOLDER[scanAgent]}
            value={models.scan ?? ''}
            onChange={(v) => setModels({ ...models, scan: v })}
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
  );
}
