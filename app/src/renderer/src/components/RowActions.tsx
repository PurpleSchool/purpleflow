// Кнопки в строках списков скиллов и MCP: открыть скилл для правки, удаление в два шага.
import { LoaderCircle, Pencil, Trash2 } from 'lucide-react';
import type { ChatSkill } from '@purpleflow/core';
import { bridge } from '../lib/api';
import { useState } from 'react';

/**
 * Первое нажатие спрашивает («Удалить из проекта?»), второе удаляет. Вопрос держится, пока кнопка в фокусе:
 * после первого нажатия фокус на ней, поэтому второй клик всегда попадает в «Удалить», как бы долго он ни шёл.
 * Снимается по уходу фокуса, Escape или после удаления.
 *
 * Таймера здесь быть не должно: он снимал вопрос раньше, чем приходил неспешный второй клик, кнопка под
 * курсором снова становилась «Удалить», клик только заново взводил вопрос — удаление молча не происходило.
 */
export function ConfirmDelete({
  name,
  ask,
  title,
  onConfirm,
}: {
  name: string;
  ask: string;
  title?: string;
  onConfirm: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirm)
    return (
      <button type="button" className="skill-del" aria-label={`Удалить ${name}`} title="Удалить" onClick={() => setConfirm(true)}>
        <Trash2 size={14} />
      </button>
    );
  return (
    <button
      type="button"
      className="skill-del is-confirm"
      disabled={busy}
      title={title}
      onBlur={() => {
        // Пока идёт удаление, кнопка гаснет сама: вопрос не должен исчезнуть под рукой.
        if (!busy) setConfirm(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setConfirm(false);
        }
      }}
      onClick={() => {
        setBusy(true);
        void onConfirm().finally(() => {
          setBusy(false);
          setConfirm(false);
        });
      }}
    >
      {busy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
      {ask}
    </button>
  );
}

/** Открыть файл скилла (SKILL.md или команду) в редакторе системы — править текст. */
export function OpenSkill({ s }: { s: ChatSkill }) {
  return (
    <button
      type="button"
      className="skill-del"
      aria-label={`Открыть ${s.name}`}
      title={`Открыть для правки: ${s.path}`}
      onClick={() => void bridge.openPath(s.path)}
    >
      <Pencil size={14} />
    </button>
  );
}
