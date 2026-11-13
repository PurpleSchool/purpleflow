import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Leaf, Sparkles, X } from 'lucide-react';
import type { AgentKind, Models, Role } from '@purpleflow/core';
import { Button } from './ui';

export type Agents = Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind; scan?: AgentKind };
type PresetId = 'economy' | 'optimal' | 'max';
type Tier = 'low' | 'mid' | 'high' | 'max';

/**
 * Модели по уровням. Имена — те, что принимает и CLI, и AI-прокси PurpleSchool:
 * у claude алиасы CLI, у codex — линейка gpt-6 ступень в ступень: haiku → luna, sonnet → terra, opus → sol, Fable → astra.
 */
const TIERS: Record<AgentKind, Record<Tier, string>> = {
  claude: { low: 'haiku', mid: 'sonnet', high: 'opus', max: 'claude-fable-5-2' },
  codex: { low: 'gpt-6-luna', mid: 'gpt-6.1-terra', high: 'gpt-6-sol', max: 'gpt-6-astra' },
};

type Slot = Role | 'visual' | 'manager' | 'scan';
/**
 * Уровень модели по ролям. Все роли — на основном агенте, и от пресета к пресету все растут на ступень:
 * сильнее всех — планировщик и ревьюер (от плана и проверки зависит качество), за ними — исполнитель и менеджер,
 * ниже — визуальная проверка и сканирование.
 */
const PRESETS: { id: PresetId; title: string; text: string; icon: ReactNode; tiers: Record<Slot, Tier> }[] = [
  {
    id: 'economy',
    title: 'Экономный',
    text: 'Рабочая модель планирует и проверяет, быстрая делает остальное. Для простых задач и правок.',
    icon: <Leaf size={18} />,
    tiers: { planner: 'mid', executor: 'low', reviewer: 'mid', visual: 'low', manager: 'low', scan: 'low' },
  },
  {
    id: 'optimal',
    title: 'Оптимальный',
    text: 'Сильная модель планирует и проверяет, рабочая пишет код. Баланс цены и качества.',
    icon: <Gauge size={18} />,
    tiers: { planner: 'high', executor: 'mid', reviewer: 'high', visual: 'low', manager: 'mid', scan: 'low' },
  },
  {
    id: 'max',
    title: 'Максимальное качество',
    text: 'Самая сильная модель планирует и проверяет, сильная пишет код. Дороже и медленнее.',
    icon: <Sparkles size={18} />,
    tiers: { planner: 'max', executor: 'high', reviewer: 'max', visual: 'mid', manager: 'high', scan: 'mid' },
  },
];

const ROLE_TITLE: Record<Slot, string> = {
  planner: 'Планировщик',
  executor: 'Исполнитель',
  reviewer: 'Ревьюер',
  visual: 'Визуальная проверка',
  manager: 'Менеджер прогона',
  scan: 'Сканирование проекта',
};

/** Все роли — на основном агенте: claude — только модели Anthropic, codex — только OpenAI. */
export function buildPreset(main: AgentKind, preset: PresetId): { agents: Agents; models: Models } {
  const p = PRESETS.find((x) => x.id === preset)!;
  const t = TIERS[main];
  // Ревью той же моделью находит меньше. Если уровни дали исполнителю модель ревьюера (две ступени на одной модели),
  // на ступень ниже уходит исполнитель, а не ревьюер: проверять должна модель не слабее автора кода.
  const order: Tier[] = ['max', 'high', 'mid', 'low'];
  const reviewer = t[p.tiers.reviewer];
  let executor = t[p.tiers.executor];
  if (executor === reviewer)
    executor =
      order
        .slice(order.indexOf(p.tiers.executor))
        .map((x) => t[x])
        .find((m) => m !== reviewer) ?? executor;
  // Менеджер на одной ступени с исполнителем — и на той же модели.
  const manager = p.tiers.manager === p.tiers.executor ? executor : t[p.tiers.manager];
  return {
    agents: { planner: main, executor: main, reviewer: main, visual: main, manager: main, scan: main },
    models: {
      planner: t[p.tiers.planner],
      executor,
      reviewer,
      visual: t[p.tiers.visual],
      manager,
      scan: t[p.tiers.scan],
    },
  };
}

/** Поп-ап быстрой настройки: основной агент и пресет — роли и модели расставляются сами. */
export function QuickSetup({
  installed,
  initialMain,
  onApply,
  onClose,
}: {
  installed: Record<AgentKind, boolean>;
  initialMain: AgentKind;
  onApply: (v: { agents: Agents; models: Models }) => Promise<void>;
  onClose: () => void;
}) {
  const [main, setMain] = useState<AgentKind>(
    installed[initialMain] || !installed[initialMain === 'claude' ? 'codex' : 'claude']
      ? initialMain
      : initialMain === 'claude'
        ? 'codex'
        : 'claude',
  );
  const [preset, setPreset] = useState<PresetId>('optimal');
  const [busy, setBusy] = useState(false);
  const plan = buildPreset(main, preset);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = async () => {
    setBusy(true);
    try {
      await onApply(plan);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="qs-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qs" role="dialog" aria-modal aria-labelledby="qs-title">
        <header className="qs-head">
          <div>
            <h2 id="qs-title">Быстрая настройка</h2>
            <p>Выберите основного агента и уровень — роли и модели расставятся сами. Потом любую роль можно поправить вручную.</p>
          </div>
          <button className="qs-close" aria-label="Закрыть" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="qs-section">
          <span className="qs-label">Основной агент</span>
          <div className="segmented qs-agents" role="radiogroup" aria-label="Основной агент">
            {(['claude', 'codex'] as AgentKind[]).map((a) => (
              <button key={a} role="radio" aria-checked={main === a} className={main === a ? 'is-on' : ''} onClick={() => setMain(a)}>
                {a}
                {!installed[a] && <em> · не найден</em>}
              </button>
            ))}
          </div>
        </div>

        <div className="qs-presets" role="radiogroup" aria-label="Пресет">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={preset === p.id}
              className={`qs-preset ${preset === p.id ? 'is-on' : ''}`}
              onClick={() => setPreset(p.id)}
            >
              <span className="qs-preset-icon">{p.icon}</span>
              <strong>{p.title}</strong>
              <span>{p.text}</span>
            </button>
          ))}
        </div>

        <div className="qs-plan">
          {(Object.keys(ROLE_TITLE) as Slot[]).map((r) => (
            <div key={r} className="qs-row">
              <span>{ROLE_TITLE[r]}</span>
              <span className="grow" />
              <span className={`qs-agent qs-agent-${plan.agents[r] ?? main}`}>{plan.agents[r] ?? main}</span>
              <code>{plan.models[r]}</code>
            </div>
          ))}
          <p className="qs-note">
            Все роли — на {main}
            {main === 'claude' ? ', модели Anthropic' : ', модели OpenAI'}. Самые сильные модели — у планировщика и ревьюера: от плана и
            проверки зависит качество. Ревьюер работает на другой модели, чем исполнитель: так он находит больше ошибок.
          </p>
        </div>

        <footer className="qs-foot">
          <Button tone="quiet" onClick={onClose}>
            Отмена
          </Button>
          <Button tone="primary" busy={busy} onClick={() => void apply()}>
            Применить
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
