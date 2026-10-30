import { useEffect, useRef, useState } from 'react';
import { Globe, Wrench, CircleCheck, ClipboardCheck, RotateCcw, UserRoundCheck } from 'lucide-react';
import type { StageId } from '@purpleflow/core';
import { Button, TextArea } from '../../components/ui';

export function GateBar(props: {
  gate: StageId; comment: string; setComment: (s: string) => void; lineCount: number; busy: string | null; error: string | null;
  onApprove: () => void; onReject: () => void; onCancel: () => void; onOpenAccept: () => void; diffShown: boolean;
  onOpenApp?: () => void;
  onAccept?: () => void;
  /** Куда ведёт «Дальше как есть» с гейта исчерпанных попыток. */
  acceptTo?: 'visual' | 'gate2';
  onFix?: () => void;
  /** Сколько замечаний ревьюера выбрано галочками на приёмке. */
  pickedCount?: number;
}) {
  const { gate, comment, setComment, lineCount, busy, error } = props;
  const [open, setOpen] = useState(false);
  // Горячие клавиши: ⌘↵ — принять, ⌘⇧↵ — вернуть, ⌘⌥↵ — поправить (приёмка). В поле комментария к гейту ⌘↵ отправляет его.
  const keys = useRef(props);
  keys.current = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.repeat) return;
      const p = keys.current;
      if (p.busy) return;
      const el = document.activeElement as HTMLElement | null;
      const inGateComment = Boolean(el?.closest('.gate-comment'));
      // Свои ⌘↵ у полей замечаний к строкам и пунктам плана — не перехватываем. Monaco с диффом — не поле ввода.
      const inField = !inGateComment && el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && !el.closest('.monaco-editor');
      if (inField) return;
      const hasText = Boolean(p.comment.trim()) || p.lineCount > 0;
      const back = () => (hasText ? p.onReject() : setOpen(true));
      const fix = () => (hasText || (p.pickedCount ?? 0) > 0 ? p.onFix?.() : setOpen(true));
      e.preventDefault();
      e.stopPropagation();
      if (p.gate === 'limit') return e.shiftKey ? p.onCancel() : p.onApprove();
      if (e.altKey && p.gate === 'gate2' && p.onFix) return fix();
      if (e.shiftKey) return back();
      if (inGateComment && hasText) return p.gate === 'gate2' && p.onFix ? fix() : back();
      p.onApprove();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const mod = window.purpleflow.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const title = gate === 'gate1' ? 'Утверждение плана' : gate === 'gate2' ? 'Приёмка' : 'Попытки исчерпаны';
  const needsComment = gate !== 'limit';
  return (
    <div className="gatebar is-gate">
      <div className="gate-sign" aria-hidden>{gate === 'gate2' ? <ClipboardCheck size={17} /> : <UserRoundCheck size={17} />}</div>
      <div className="gate-text">
        <strong>{title}</strong>
        <span>
          {gate === 'gate1' && (props.diffShown ? (lineCount ? `Замечаний к плану: ${lineCount}. Они уйдут планировщику при возврате.` : 'Проверьте proposal и tasks. Наведите на пункт и нажмите значок, чтобы оставить замечание.') : 'Откройте план и проверьте proposal и tasks.')}
          {gate === 'gate2' && (props.diffShown ? `Замечаний на строках: ${lineCount}. Они уйдут исполнителю при возврате.` : 'Посмотрите дифф и замечания ревьюера.')}
          {gate === 'limit' && 'Можно дать исполнителю ещё одну попытку с вашим комментарием.'}
        </span>
      </div>
      {(open || gate === 'limit') && (
        <TextArea
          className="gate-comment"
          rows={2}
          autoFocus={open}
          placeholder={gate === 'limit' ? 'Подсказка исполнителю (необязательно)' : gate === 'gate2' ? 'Что поправить — например: «кнопку сделать синей», «добавить пустое состояние»' : 'Что доработать'}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <div className="gate-actions">
        {error && <span className="actionbar-error">{error}</span>}
        {props.onOpenApp && <Button tone="quiet" icon={<Globe size={14} />} onClick={props.onOpenApp}>Проверить в браузере</Button>}
        {!props.diffShown && gate !== 'limit' && <Button tone="quiet" onClick={props.onOpenAccept}>{gate === 'gate1' ? 'Открыть план' : 'Открыть дифф'}</Button>}
        {gate === 'gate1' && <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>Отменить задачу</Button>}
        {gate === 'limit' ? (
          <>
            <Button tone="quiet" busy={busy === 'cancel'} onClick={props.onCancel}>Остановить</Button>
            {props.onAccept && <Button tone="ghost" icon={<ClipboardCheck size={14} />} busy={busy === 'accept'} onClick={props.onAccept} title={props.acceptTo === 'visual' ? 'Без новых попыток: визуальная проверка, затем приёмка — решение за вами' : 'Посмотреть дифф и решить самому — без новых попыток'}>{props.acceptTo === 'visual' ? 'Дальше: визуальная проверка' : 'К приёмке как есть'}</Button>}
            <Button tone="primary" icon={<RotateCcw size={14} />} busy={busy === 'approve'} onClick={props.onApprove}>Ещё попытка <kbd className="kbd-mini">{mod}↵</kbd></Button>
          </>
        ) : (
          <>
            {gate === 'gate2' && props.onFix && (props.pickedCount ?? 0) > 0 && !open && lineCount === 0 && (
              <Button tone="ghost" icon={<Wrench size={14} />} busy={busy === 'fix'} onClick={props.onFix} title="Выбранные замечания ревьюера — исполнителю: реализация → проверки → снова приёмка, без нового ревью">
                Исправить выбранные ({props.pickedCount}) <kbd className="kbd-mini">{mod}⌥↵</kbd>
              </Button>
            )}
            {needsComment && !open && lineCount === 0 ? (
              <Button tone="ghost" icon={<RotateCcw size={14} />} onClick={() => setOpen(true)} title={`${mod}⇧↵`}>{gate === 'gate2' ? 'Есть замечания' : 'Вернуть с комментарием'}</Button>
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
                    Поправить{lineCount || props.pickedCount ? ` (+${lineCount + (props.pickedCount ?? 0)})` : ''} <kbd className="kbd-mini">{mod}⌥↵</kbd>
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
                  {gate === 'gate2' ? 'Вернуть на доработку' : `Вернуть${lineCount ? ` (+${lineCount})` : ''}`} <kbd className="kbd-mini">{mod}⇧↵</kbd>
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
