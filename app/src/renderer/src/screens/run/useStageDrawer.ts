import type { RunFile, StageId } from '@purpleflow/core';
import { useEffect, useRef, useState } from 'react';
import { isGate } from '../../lib/bars';
import { runStages } from '../../lib/stages';

/**
 * Панель деталей стадии справа от таймлайна: какая стадия открыта, какая попытка выбрана, анимация закрытия
 * и клавиатура — Esc закрывает, ↑/↓ — соседняя стадия, ←/→ — попытки.
 * onAccept — открыть приёмку: это вкладка «Код», а не панель.
 */
export function useStageDrawer(run: RunFile | undefined, onAccept: () => void) {
  /** Стадия, чьи детали открыты; null — панель закрыта. */
  const [drawer, setDrawer] = useState<StageId | null>(null);
  /** Выбранная попытка стадии; null — последняя. */
  const [attemptNo, setAttemptNo] = useState<number | null>(null);
  /** Идёт обратная анимация: детали гаснут, гант разворачивается — потом панель размонтируется. */
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = () => {
    if (!drawer || closing) return;
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setDrawer(null);
      setClosing(false);
    }, 520);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const open = (s: StageId) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setClosing(false);
    if (s === 'gate2') {
      setDrawer(null);
      onAccept();
      return;
    }
    setDrawer(s);
    setAttemptNo(null);
  };

  /** Сразу убрать панель, без анимации: переход на другую вкладку. */
  const reset = () => {
    setDrawer(null);
    setClosing(false);
    setAttemptNo(null);
  };

  const tries = run && drawer ? run.attempts.filter((a) => a.stage === drawer && !isGate(a.stage)) : [];
  const attempt = tries.find((a) => a.attempt === attemptNo) ?? tries[tries.length - 1];
  const attemptIdx = attempt ? tries.indexOf(attempt) : -1;

  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable], .monaco-editor') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && drawer) {
        e.preventDefault();
        close();
        return;
      }
      if (!drawer) return;
      const order = runStages(run)
        .map((x) => x.id)
        .filter((id) => run.attempts.some((a) => a.stage === id) || id === run.next);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = order.indexOf(drawer);
        const next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) open(next);
        e.preventDefault();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && tries.length > 1) {
        const i = Math.min(tries.length - 1, Math.max(0, attemptIdx + (e.key === 'ArrowRight' ? 1 : -1)));
        setAttemptNo(tries[i].attempt);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { drawer, closing, open, close, reset, tries, attempt, attemptIdx, setAttemptNo };
}

export type StageDrawerState = ReturnType<typeof useStageDrawer>;
