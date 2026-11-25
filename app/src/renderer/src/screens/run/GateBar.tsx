import { useEffect, useRef, useState } from 'react';
import { Globe, Wrench, CircleCheck, ClipboardCheck, RotateCcw, UserRoundCheck, MessageCircleQuestion } from 'lucide-react';
import type { ReviewItem, StageId } from '@purpleflow/core';
import { Button, TextArea } from '../../components/ui';
import { bridge } from '../../lib/api';
import { isShortcutInput } from '../../lib/keyboard';

export function GateBar(props: {
  gate: StageId;
  comment: string;
  setComment: (s: string) => void;
  lineCount: number;
  busy: string | null;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
  onOpenAccept: () => void;
  diffShown: boolean;
  onOpenApp?: () => void;
  onAccept?: () => void;
  /** Куда ведёт «Дальше как есть» с гейта исчерпанных попыток. */
  acceptTo?: 'visual' | 'gate2';
  onFix?: () => void;
  /** Сколько замечаний ревьюера выбрано галочками на приёмке. */
  pickedCount?: number;
  /** Исполнитель и ревьюер ходят по кругу: эти замечания вернулись неисправленными. */
  stuck?: ReviewItem[];
  /** Разбор ревью кода: правок в этом прогоне нет — «Завершить» или выбранное в новую задачу (чат). */
  codeReview?: { fixTo: 'task' | 'chat'; findings: number };
}) {
  const { gate, comment, setComment, lineCount, busy, error } = props;
  // Черновик комментария сохраняется между заходами на экран — тогда поле сразу открыто.
  const [open, setOpen] = useState(() => comment !== '');
  // Горячие клавиши: ⌘↵ — принять, ⌘⇧↵ — вернуть, ⌘⌥↵ — поправить (приёмка). В поле комментария к гейту ⌘↵ отправляет его.
  const keys = useRef(props);
  keys.current = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.repeat) return;
      const p = keys.current;
      if (p.busy) return;
      const el = document.activeElement;
      const inGateComment = Boolean(el?.closest('.gate-comment'));
      // Свои ⌘↵ у полей замечаний к строкам и пунктам плана — не перехватываем.
      if (!inGateComment && isShortcutInput(el)) return;
      const hasText = Boolean(p.comment.trim()) || p.lineCount > 0;
      const back = () => (hasText ? p.onReject() : setOpen(true));
      const fix = () => (hasText || (p.pickedCount ?? 0) > 0 ? p.onFix?.() : setOpen(true));
      e.preventDefault();
      e.stopPropagation();
      // Разбор ревью кода: ⌘↵ — завершить, ⌘⌥↵ — исправить выбранное; возвращать некуда.
      if (p.codeReview) return e.altKey ? fix() : e.shiftKey ? undefined : p.onApprove();
      // Отмена прогона необратима и подсказки у неё нет — только кнопкой.
      if (p.gate === 'limit') return e.shiftKey ? undefined : p.onApprove();
      if (e.altKey && p.gate === 'gate2' && p.onFix) return fix();
      if (e.shiftKey) return back();
      if (inGateComment && hasText) return p.gate === 'gate2' && p.onFix ? fix() : back();
      // Принятие молча выбросило бы замечания: ⌘↵, добавивший замечание к строке, легко нажать второй раз.
      if (hasText) return setOpen(true);
      p.onApprove();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const mod = bridge.platform === 'darwin' ? '⌘' : 'Ctrl+';
  if (props.codeReview) return <CodeReviewBar {...props} fixTo={props.codeReview.fixTo} findings={props.codeReview.findings} mod={mod} />;
  const stuck = gate === 'limit' && props.stuck?.length ? props.stuck : null;
  const title = gate === 'gate1' ? 'Утверждение плана' : gate === 'gate2' ? 'Приёмка' : stuck ? 'Ходят по кругу' : 'Попытки исчерпаны';
  const needsComment = gate !== 'limit';
  return (
    <div className="gatebar is-gate">
      <div className="gate-sign" aria-hidden>
        {gate === 'gate2' ? <ClipboardCheck size={17} /> : <UserRoundCheck size={17} />}
      </div>
      <div className="gate-text">
        <strong>{title}</strong>
        <span>
          {gate === 'gate1' &&
            (props.diffShown
              ? lineCount
                ? `Замечаний к плану: ${lineCount}. Они уйдут планировщику при возврате.`
                : 'Проверьте proposal и tasks. Наведите на пункт и нажмите значок, чтобы оставить замечание.'
              : 'Откройте план и проверьте proposal и tasks.')}
          {gate === 'gate2' &&
            (props.diffShown
              ? `Замечаний на строках: ${lineCount}. Они уйдут исполнителю при возврате.`
              : 'Посмотрите дифф и замечания ревьюера.')}
          {gate === 'limit' &&
            (stuck
              ? 'Ревьюер вернул те же замечания после попытки их исправить. Разберите спор: уточнение увидят и исполнитель, и ревьюер.'
              : 'Можно дать исполнителю ещё одну попытку с вашим комментарием.')}
        </span>
      </div>
      {stuck && (
        <ul className="gate-stuck" aria-label="Замечания, которые не сдвинулись">
          {stuck.map((i, n) => (
            <li key={n}>
              {i.file && (
                <code>
                  {i.file}
                  {i.line ? `:${i.line}` : ''}
                </code>
              )}{' '}
              {i.message.split('\n')[0]}
            </li>
          ))}
        </ul>
      )}
      {(open || gate === 'limit') && (
        <TextArea
          className="gate-comment"
          rows={2}
          autoFocus={open}
          placeholder={
            gate === 'limit'
              ? stuck
                ? 'Уточните замечание: в чём ревьюер не прав или как именно исправить — например, «проверка на null уже есть в parse()»'
                : 'Подсказка исполнителю (необязательно)'
              : gate === 'gate2'
                ? 'Что поправить — например: «кнопку сделать синей», «добавить пустое состояние»'
                : 'Что доработать'
          }
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <div className="gate-actions">
        {error && <span className="actionbar-error">{error}</span>}
        {props.onOpenApp && (
          <Button tone="quiet" icon={<Globe size={14} />} onClick={props.onOpenApp}>
            Проверить в браузере
          </Button>
        )}
        {!props.diffShown && gate !== 'limit' && (
          <Button tone="quiet" onClick={props.onOpenAccept}>
            {gate === 'gate1' ? 'Открыть план' : 'Открыть дифф'}
          </Button>
        )}
        {gate === 'gate1' && (
          <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>
            Отменить задачу
          </Button>
        )}
        {gate === 'limit' ? (
          <>
            <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>
              Остановить
            </Button>
            {props.onAccept && (
              <Button
                tone="ghost"
                icon={<ClipboardCheck size={14} />}
                busy={busy === 'accept'}
                onClick={props.onAccept}
                title={
                  props.acceptTo === 'visual'
                    ? 'Без новых попыток: визуальная проверка, затем приёмка — решение за вами'
                    : 'Посмотреть дифф и решить самому — без новых попыток'
                }
              >
                {props.acceptTo === 'visual' ? 'Дальше: визуальная проверка' : 'К приёмке как есть'}
              </Button>
            )}
            <Button tone="primary" icon={<RotateCcw size={14} />} busy={busy === 'approve'} onClick={props.onApprove}>
              {stuck ? 'Уточнить и ещё попытка' : 'Ещё попытка'} <kbd className="kbd-mini">{mod}↵</kbd>
            </Button>
          </>
        ) : (
          <>
            {gate === 'gate2' && props.onFix && (props.pickedCount ?? 0) > 0 && !open && lineCount === 0 && (
              <Button
                tone="ghost"
                icon={<Wrench size={14} />}
                busy={busy === 'fix'}
                onClick={props.onFix}
                title="Выбранные замечания ревьюера — исполнителю: реализация → проверки → снова приёмка, без нового ревью"
              >
                Исправить выбранные ({props.pickedCount}) <kbd className="kbd-mini">{mod}⌥↵</kbd>
              </Button>
            )}
            {needsComment && !open && lineCount === 0 ? (
              <Button tone="ghost" icon={<RotateCcw size={14} />} onClick={() => setOpen(true)} title={`${mod}⇧↵`}>
                {gate === 'gate2' ? 'Есть замечания' : 'Вернуть с комментарием'}
              </Button>
            ) : (
              <>
                {gate === 'gate2' && props.onFix && (
                  <Button
                    tone="ghost"
                    icon={<Wrench size={14} />}
                    busy={busy === 'fix'}
                    disabled={!comment.trim() && lineCount === 0 && !props.pickedCount}
                    onClick={props.onFix}
                    title="Небольшая правка в той же ветке: реализация → проверки → снова приёмка, без ревью и визуальной проверки"
                  >
                    Поправить{lineCount || props.pickedCount ? ` (+${lineCount + (props.pickedCount ?? 0)})` : ''}{' '}
                    <kbd className="kbd-mini">{mod}⌥↵</kbd>
                  </Button>
                )}
                <Button
                  tone="ghost"
                  icon={<RotateCcw size={14} />}
                  busy={busy === 'reject'}
                  disabled={!comment.trim() && lineCount === 0}
                  onClick={props.onReject}
                  title={gate === 'gate2' ? 'Полный круг: реализация → проверки → ревью → визуальная проверка' : undefined}
                >
                  {gate === 'gate2' ? 'Вернуть на доработку' : `Вернуть${lineCount ? ` (+${lineCount})` : ''}`}{' '}
                  <kbd className="kbd-mini">{mod}⇧↵</kbd>
                </Button>
              </>
            )}
            <Button tone="approve" icon={<CircleCheck size={15} />} busy={busy === 'approve'} onClick={props.onApprove}>
              {gate === 'gate1' ? 'Принять план' : 'Принять'} <kbd className="kbd-mini">{mod}↵</kbd>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Разбор ревью кода: выбрать замечания и отправить их на исправление — или просто завершить. */
function CodeReviewBar(props: Parameters<typeof GateBar>[0] & { fixTo: 'task' | 'chat'; findings: number; mod: string }) {
  const { comment, setComment, lineCount, busy, error, mod } = props;
  const picked = (props.pickedCount ?? 0) + lineCount;
  // Черновик комментария сохраняется между заходами на экран — тогда поле сразу открыто.
  const [open, setOpen] = useState(() => comment !== '');
  const canFix = picked > 0 || Boolean(comment.trim());
  // Замечаний нет — исправлять нечего, пока человек сам не оставит замечание на строке или комментарий.
  const clean = props.findings === 0;
  return (
    <div className="gatebar is-gate">
      <div className="gate-sign" aria-hidden>
        <ClipboardCheck size={17} />
      </div>
      <div className="gate-text">
        <strong>{clean ? 'Замечаний нет' : 'Разбор'}</strong>
        <span>
          {clean
            ? 'Ревьюер не нашёл проблем. Посмотрите код сами: если что-то не так — оставьте замечание на строке, иначе завершите ревью.'
            : `${
                props.diffShown
                  ? 'Отметьте замечания, которые нужно исправить, или оставьте свои на строках.'
                  : 'Посмотрите код и замечания ревьюера.'
              } ${
                props.fixTo === 'chat'
                  ? 'Исправлять будет чат прямо в рабочей копии проекта.'
                  : 'Исправления пойдут новой задачей от проверенного кода.'
              }`}
        </span>
      </div>
      {open && (
        <TextArea
          className="gate-comment"
          rows={2}
          autoFocus
          placeholder="Что ещё поправить — добавится к выбранным замечаниям"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <div className="gate-actions">
        {error && <span className="actionbar-error">{error}</span>}
        {!props.diffShown && (
          <Button tone="quiet" onClick={props.onOpenAccept}>
            Открыть код
          </Button>
        )}
        {!open && (
          <Button tone="quiet" onClick={() => setOpen(true)}>
            Добавить комментарий
          </Button>
        )}
        {(!clean || canFix) && (
          <Button
            tone="ghost"
            icon={<Wrench size={14} />}
            busy={busy === 'fix'}
            disabled={!canFix}
            onClick={props.onFix}
            title={
              props.fixTo === 'chat'
                ? 'Завершить ревью и открыть новый чат с проектом — выбранные замечания уже в сообщении'
                : 'Завершить ревью и открыть новую задачу — выбранные замечания уже в её тексте'
            }
          >
            {props.fixTo === 'chat' ? 'Исправить в чате' : 'Исправить задачей'}
            {picked ? ` (${picked})` : ''}
          </Button>
        )}
        <Button tone="approve" icon={<CircleCheck size={15} />} busy={busy === 'approve'} onClick={props.onApprove}>
          Завершить <kbd className="kbd-mini">{mod}↵</kbd>
        </Button>
      </div>
    </div>
  );
}

/** Гейт вопросов перед планом: ответы — в панели уточнения, здесь — продолжить без них или отменить задачу. */
export function ClarifyGateBar({
  busy,
  error,
  onCancel,
  onSkip,
}: {
  busy: string | null;
  error: string | null;
  onCancel: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="gatebar is-gate">
      <div className="gate-sign" aria-hidden>
        <MessageCircleQuestion size={17} />
      </div>
      <div className="gate-text">
        <strong>Вопросы перед планом</strong>
        <span>Ответьте выше — ответы получат все стадии. Можно продолжить и без них: планировщик решит сам.</span>
      </div>
      <div className="gate-actions">
        {error && <span className="actionbar-error">{error}</span>}
        <Button tone="quiet" busy={busy === 'cancel'} onClick={onCancel}>
          Отменить задачу
        </Button>
        <Button tone="ghost" busy={busy === 'skip'} onClick={onSkip}>
          Продолжить без ответов
        </Button>
      </div>
    </div>
  );
}
