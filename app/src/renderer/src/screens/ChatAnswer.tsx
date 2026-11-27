// Ответ агента в чате: текст, размышления, вызовы с итогами и шагами субагентов, план, уведомления, вопросы.
import { Fragment, useState } from 'react';
import {
  Brain,
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  FilePen,
  Info,
  ListChecks,
  LockOpen,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  ShieldOff,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import type { ChatMessage, ChatPart, ChatPermissionPart, ChatQuestion, ChatToolPart, ToolStatus } from '@purpleflow/core';
import { GeneratedMedia } from '../components/GeneratedMedia';
import { MediaOfferCard } from '../components/MediaOfferCard';
import { Markdown } from '../components/Markdown';
import { Button } from '../components/ui';
import { cleanErr } from '../lib/api';
import { answerFooter, answerText, chatBlocks, shownTools } from '../lib/chatBlocks';

const plural = (n: number) =>
  n === 1 ? 'действие' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'действия' : 'действий';

/** Ответ: блоки по порядку, индикатор, пока пишется, и итоги хода. answerable — на вопросы агента ещё можно ответить. */
export function AssistantMessage({
  m,
  answerable,
  onAnswer,
  onAllowMcp,
  onGrantFull,
  onPermission,
}: {
  m: ChatMessage;
  answerable: boolean;
  onAnswer: (text: string) => void;
  onAllowMcp?: (t: McpApproval, always: boolean) => void;
  /** Чат в режиме правок: отказ песочницы можно снять полным доступом. */
  onGrantFull?: () => void;
  /** Ответ на запрос разрешения agy, пока ход идёт. */
  onPermission?: (requestId: string, answer: 'once' | 'always' | 'deny') => Promise<void>;
}) {
  const blocks = chatBlocks(m);
  const refused = m.pending ? [] : refusedMcp(blocks);
  const sandboxed =
    !m.pending &&
    Boolean(onGrantFull) &&
    (m.needsFullAccess || blocks.some((b) => b.kind === 'tools' && b.items.some((t) => t.sandboxDenied)));
  const live = Boolean(m.pending);
  const tail = blocks[blocks.length - 1];
  const footer = live ? [] : answerFooter(m);
  return (
    <div className={`chat-msg is-assistant ${m.error ? 'is-error' : ''}`}>
      {blocks.map((b, i) => {
        const isLast = i === blocks.length - 1;
        switch (b.kind) {
          case 'tools':
            return (
              <Fragment key={i}>
                <ToolSteps items={b.items} live={live && isLast} />
                {/* Нарисованные картинки — сразу видно, не в свёрнутом списке вызовов. */}
                <GeneratedMedia items={b.items} />
              </Fragment>
            );
          case 'thinking':
            return <Thinking key={i} text={b.text} live={live && isLast} />;
          case 'todos':
            return <Todos key={i} items={b.items} />;
          case 'notice':
            return <Notice key={i} level={b.level} text={b.text} />;
          case 'question':
            return <QuestionCard key={i} questions={b.questions} answerable={answerable} onAnswer={onAnswer} />;
          case 'permission':
            return <PermissionCard key={b.id} p={b} live={live} onAnswer={onPermission} />;
          // Предложения (подписка, вход, включить картинки) — в конце ответа, ниже текста.
          case 'offer':
            return null;
          default:
            return <Markdown key={i} className="md chat-md" source={b.text} />;
        }
      })}
      {!live &&
        blocks
          .filter((b): b is Extract<typeof b, { kind: 'offer' }> => b.kind === 'offer')
          .map((b) => <MediaOfferCard key={b.offer} offer={b.offer} />)}
      {refused.map((t) => (
        <McpApprovalCard
          key={`${t.server}/${t.tool}`}
          t={t}
          answerable={answerable && Boolean(onAllowMcp)}
          onAllow={(a) => onAllowMcp?.(t, a)}
        />
      ))}
      {sandboxed && (
        <div className="chat-banner">
          <ShieldAlert size={16} />
          <div className="chat-banner-text">
            <strong>Нужен полный доступ</strong>
            <p>
              В режиме «Правки» закрыты запись в <code>.git</code>, остановка процессов и файлы вне проекта.
            </p>
          </div>
          {answerable && (
            <Button tone="ghost" icon={<ShieldOff size={14} />} onClick={onGrantFull}>
              Дать доступ и повторить
            </Button>
          )}
        </div>
      )}
      {live && (!tail || (tail.kind !== 'text' && tail.kind !== 'thinking')) && (
        <div className="chat-typing" aria-label="Агент отвечает">
          <i />
          <i />
          <i />
        </div>
      )}
      {m.changedFiles?.length ? (
        <div className="chat-changed">
          <FilePen size={13} />
          <span>Изменены: </span>
          {m.changedFiles.map((f) => (
            <code key={f}>{f}</code>
          ))}
        </div>
      ) : null}
      {m.stopped && <p className="chat-note">Ответ остановлен.</p>}
      {m.error && <p className="chat-msg-error">{cleanErr(m.error)}</p>}
      {footer.length > 0 && <p className="chat-meta">{footer.join(' · ')}</p>}
    </div>
  );
}

function StatusIcon({ status }: { status?: ToolStatus }) {
  if (status === 'running') return <LoaderCircle size={12} className="chat-tool-spin" aria-label="Выполняется" />;
  if (status === 'error') return <X size={12} className="chat-tool-err" aria-label="Ошибка" />;
  if (status === 'ok') return <Check size={12} className="chat-tool-ok" aria-label="Готово" />;
  return null;
}

/** Группа вызовов: свёрнута до последнего и упавших; строку с подробностями можно раскрыть. */
function ToolSteps({ items, live }: { items: ChatToolPart[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = shownTools(items, open);
  const failed = items.filter((t) => t.status === 'error').length;
  return (
    <div className={`chat-tools ${live ? 'is-live' : ''}`}>
      <button className="chat-tools-head" onClick={() => setOpen(!open)}>
        <Wrench size={12} /> {items.length} {plural(items.length)}
        {failed ? <span className="chat-tools-failed"> · с ошибкой: {failed}</span> : null}
        {open ? ' · скрыть' : items.length > shown.length ? ' · показать все' : ''}
      </button>
      {shown.map((t, i) => (
        <ToolRow key={t.id ?? i} t={t} />
      ))}
    </div>
  );
}

function ToolRow({ t }: { t: ChatToolPart }) {
  const [open, setOpen] = useState(false);
  const more = Boolean(t.detail || t.output || t.sub?.length);
  return (
    <div className={`chat-tool-wrap ${t.status ? `is-${t.status}` : ''}`}>
      <button type="button" className="chat-tool" disabled={!more} aria-expanded={more ? open : undefined} onClick={() => setOpen(!open)}>
        <StatusIcon status={t.status} />
        <span>{t.text}</span>
        {t.sub?.length ? <span className="chat-tool-count">{t.sub.length}</span> : null}
      </button>
      {open && (
        <div className="chat-tool-more">
          {t.sub?.length ? (
            <ul className="chat-sub">
              {t.sub.map((s, i) => (
                <li key={s.id ?? i} className={s.status ? `is-${s.status}` : ''}>
                  <StatusIcon status={s.status} />
                  <code>{s.text}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {t.detail && <pre className="chat-tool-detail">{t.detail}</pre>}
          {t.output && <pre className={`chat-tool-output ${t.status === 'error' ? 'is-error' : ''}`}>{t.output}</pre>}
        </div>
      )}
    </div>
  );
}

/** Размышления модели: свёрнуты; без текста (скрытые размышления) видна только метка, пока модель думает. */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim() && !live) return null;
  return (
    <div className={`chat-thinking ${live ? 'is-live' : ''}`}>
      <button type="button" disabled={!text.trim()} onClick={() => setOpen(!open)}>
        <Brain size={12} /> {live ? 'Думает…' : 'Размышления'}
        {text.trim() ? (open ? ' · скрыть' : ' · показать') : ''}
      </button>
      {open && text.trim() && <p>{text.trim()}</p>}
    </div>
  );
}

function Todos({ items }: { items: Extract<ChatPart, { kind: 'todos' }>['items'] }) {
  const done = items.filter((t) => t.status === 'completed').length;
  return (
    <div className="chat-todos">
      <div className="chat-todos-head">
        <ListChecks size={13} /> План · {done} из {items.length}
      </div>
      <ul>
        {items.map((t, i) => (
          <li key={i} className={`is-${t.status}`}>
            {t.status === 'completed' ? (
              <CircleCheck size={13} />
            ) : t.status === 'in_progress' ? (
              <CircleDot size={13} />
            ) : (
              <Circle size={13} />
            )}
            <span>{t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notice({ level, text }: { level: 'info' | 'warn' | 'error'; text: string }) {
  const Icon = level === 'error' ? CircleAlert : level === 'warn' ? TriangleAlert : Info;
  return (
    <p className={`chat-notice is-${level}`}>
      <Icon size={13} />
      <span>{text}</span>
    </p>
  );
}

/** Вопросы агента: один вопрос с одним ответом уходит по клику, иначе — кнопкой «Ответить». */
type McpApproval = NonNullable<ChatToolPart['approval']>;

/** Вызовы MCP, в которых codex отказал без подтверждения, — по одному на инструмент. */
function refusedMcp(blocks: ReturnType<typeof chatBlocks>): McpApproval[] {
  const out = new Map<string, McpApproval>();
  for (const b of blocks)
    if (b.kind === 'tools') for (const t of b.items) if (t.approval) out.set(`${t.approval.server}/${t.approval.tool}`, t.approval);
  return [...out.values()];
}

/** codex exec не умеет спросить человека: разрешение даём после отказа и просим повторить вызов. */
const PERMISSION_DONE: Record<Exclude<ChatPermissionPart['state'], 'pending'>, string> = {
  once: 'Разрешено один раз',
  always: 'Разрешено в этом чате',
  denied: 'Отклонено',
  expired: 'Ответ не понадобился — ход закончился',
};

/** Агент просит действие, которое режим «Правки» не пускает: решение — здесь же, агент ждёт. */
function PermissionCard({
  p,
  live,
  onAnswer,
}: {
  p: ChatPermissionPart;
  live: boolean;
  onAnswer?: (requestId: string, answer: 'once' | 'always' | 'deny') => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const waiting = p.state === 'pending' && live && Boolean(onAnswer);
  if (p.state !== 'pending' || !live) {
    const state = p.state === 'pending' ? 'expired' : p.state;
    const Icon = state === 'denied' ? ShieldX : state === 'expired' ? ShieldAlert : ShieldCheck;
    return (
      <div className={`chat-permission-done is-${state}`}>
        <Icon size={13} />
        <span>{PERMISSION_DONE[state]}:</span>
        <code>{p.detail ?? p.text}</code>
      </div>
    );
  }
  const answer = (a: 'once' | 'always' | 'deny') => {
    setBusy(a);
    setError('');
    onAnswer?.(p.id, a).catch((e) => {
      setBusy(null);
      setError(cleanErr(e));
    });
  };
  return (
    <div className="chat-banner chat-permission" role="group" aria-label="Агент просит разрешение">
      <ShieldQuestion size={16} />
      <div className="chat-banner-text">
        <strong>Агент просит разрешение</strong>
        <p>В режиме «Правки» {p.reason.replace(/^стадия только читает: /, '')}. Агент ждёт вашего решения.</p>
      </div>
      <pre className="chat-permission-cmd">{p.detail ?? p.text}</pre>
      {waiting && (
        <div className="chat-permission-actions">
          <Button tone="primary" busy={busy === 'once'} disabled={Boolean(busy)} onClick={() => answer('once')}>
            Разрешить
          </Button>
          <Button tone="ghost" busy={busy === 'always'} disabled={Boolean(busy)} onClick={() => answer('always')}>
            Разрешать в этом чате
          </Button>
          <Button tone="quiet" busy={busy === 'deny'} disabled={Boolean(busy)} onClick={() => answer('deny')}>
            Отклонить
          </Button>
        </div>
      )}
      {error && <p className="chat-permission-error">{error}</p>}
    </div>
  );
}

function McpApprovalCard({ t, answerable, onAllow }: { t: McpApproval; answerable: boolean; onAllow: (always: boolean) => void }) {
  return (
    <div className="chat-question chat-mcp-approval">
      <p className="chat-question-text">
        <LockOpen size={14} />
        <span>
          Codex хотел вызвать <code>{t.server}</code> · <code>{t.tool}</code>, но без подтверждения инструмент недоступен.
        </span>
      </p>
      {answerable && (
        <div className="chat-question-options">
          <button type="button" className="chat-question-send" onClick={() => onAllow(false)}>
            Разрешить и повторить
          </button>
          <button type="button" className="chip" onClick={() => onAllow(true)}>
            Разрешать в этом чате
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  questions,
  answerable,
  onAnswer,
}: {
  questions: ChatQuestion[];
  answerable: boolean;
  onAnswer: (text: string) => void;
}) {
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const instant = questions.length === 1 && !questions[0].multiSelect;
  const toggle = (qi: number, label: string) => {
    if (instant) return onAnswer(label);
    setPicked((p) =>
      p.map((sel, i) => {
        if (i !== qi) return sel;
        if (!questions[qi].multiSelect) return [label];
        return sel.includes(label) ? sel.filter((x) => x !== label) : [...sel, label];
      }),
    );
  };
  return (
    <div className="chat-question">
      {questions.map((q, qi) => (
        <div key={qi} className="chat-question-item">
          <p className="chat-question-text">
            <MessageCircleQuestion size={14} />
            <span>{q.question}</span>
          </p>
          <div className="chat-question-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className={`chip ${picked[qi]?.includes(o.label) ? 'is-on' : ''}`}
                disabled={!answerable}
                title={o.description}
                onClick={() => toggle(qi, o.label)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {!instant && answerable && (
        <button
          type="button"
          className="chat-question-send"
          disabled={picked.every((p) => !p.length)}
          onClick={() => onAnswer(answerText(questions, picked))}
        >
          Ответить
        </button>
      )}
      {answerable && <p className="chat-note">Можно ответить своими словами в поле ниже.</p>}
    </div>
  );
}
