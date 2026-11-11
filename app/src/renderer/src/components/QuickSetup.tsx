import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Leaf, Sparkles, X } from 'lucide-react';
import type { AgentKind, Models, Role } from '@purpleflow/core';
import { Button } from './ui';

export type Agents = Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind };
type PresetId = 'economy' | 'optimal' | 'max';
type Tier = 'low' | 'mid' | 'high' | 'max';

/**
 * Модели по уровням. Имена — те, что принимает и CLI, и AI-прокси PurpleSchool:
 * у claude алиасы CLI, у codex — линейка gpt-6 (astra — самая сильная, luna — быстрая).
 */
const TIERS: Record<AgentKind, Record<Tier, string>> = {
  claude: { low: 'haiku', mid: 'sonnet', high: 'opus', max: 'claude-fable-5-2' },
  codex: { low: 'gpt-6-luna', mid: 'gpt-6-sol', high: 'gpt-6-astra', max: 'gpt-6-astra' },
};

type Slot = Role | 'visual' | 'manager';
/** Уровень модели по ролям. Все роли — на основном агенте; ревьюер — на другой модели, чем исполнитель. */
const PRESETS: { id: PresetId; title: string; text: string; icon: ReactNode; tiers: Record<Slot, Tier> }[] = [
  {
    id: 'economy',
    title: 'Экономный',
    text: 'Быстрые недорогие модели. Подходит для простых задач и правок.',
    icon: <Leaf size={18} />,
    tiers: { planner: 'mid', executor: 'mid', reviewer: 'low', visual: 'low', manager: 'low' },
  },
  {
    id: 'optimal',
    title: 'Оптимальный',
    text: 'Сильная модель планирует, рабочая — пишет код. Баланс цены и качества.',
    icon: <Gauge size={18} />,
    tiers: { planner: 'high', executor: 'mid', reviewer: 'high', visual: 'mid', manager: 'low' },
  },
  {
    id: 'max',
    title: 'Максимальное качество',
    text: 'Самые сильные модели на всех ключевых ролях. Дороже и медленнее.',
    icon: <Sparkles size={18} />,
    tiers: { planner: 'max', executor: 'high', reviewer: 'max', visual: 'mid', manager: 'mid' },
  },
];

const ROLE_TITLE: Record<Slot, string> = {
  planner: 'Планировщик',
  executor: 'Исполнитель',
  reviewer: 'Ревьюер',
  visual: 'Визуальная проверка',
  manager: 'Менеджер прогона',
};

/** Все роли — на основном агенте: claude — только модели Anthropic, codex — только OpenAI. */
export function buildPreset(main: AgentKind, preset: PresetId): { agents: Agents; models: Models } {
  const p = PRESETS.find((x) => x.id === preset)!;
  const t = TIERS[main];
  // Ревью той же моделью находит меньше: если уровни дали одну модель, берём ступень ниже.
  const order: Tier[] = ['max', 'high', 'mid', 'low'];
  let reviewer = t[p.tiers.reviewer];
  if (reviewer === t[p.tiers.executor]) reviewer = order.map((x) => t[x]).find((m) => m !== t[p.tiers.executor]) ?? reviewer;
  return {
    agents: { planner: main, executor: main, reviewer: main, visual: main, manager: main },
    models: {
      planner: t[p.tiers.planner],
      executor: t[p.tiers.executor],
      reviewer,
      visual: t[p.tiers.visual],
      manager: t[p.tiers.manager],
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
            {main === 'claude' ? ', модели Anthropic' : ', модели OpenAI'}. Ревьюер работает на другой модели, чем исполнитель: так он
            находит больше ошибок.
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
