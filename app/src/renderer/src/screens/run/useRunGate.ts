import { useEffect, useState } from 'react';
import type { LineComment, ReviewItem } from '@purpleflow/core';

interface GateDraft {
  comment: string;
  lineComments: LineComment[];
  picked: ReviewItem[];
}

/**
 * Неотправленные решения по прогонам. Экран прогона размонтируется при уходе в настройки или в другой прогон,
 * а набранные замечания терять нельзя: держим их в памяти окна до отправки решения.
 */
const drafts = new Map<string, GateDraft>();

/**
 * Состояние решения на гейте: комментарий, замечания по строкам, отмеченные к исправлению замечания ревьюера.
 * Экран прогона пересоздаётся для каждого прогона (key в App), поэтому runId за время жизни хука не меняется.
 */
export function useRunGate(runId: string) {
  const [comment, setComment] = useState(() => drafts.get(runId)?.comment ?? '');
  const [lineComments, setLineComments] = useState<LineComment[]>(() => drafts.get(runId)?.lineComments ?? []);
  const [picked, setPicked] = useState<ReviewItem[]>(() => drafts.get(runId)?.picked ?? []);
  useEffect(() => {
    if (!comment && !lineComments.length && !picked.length) drafts.delete(runId);
    else drafts.set(runId, { comment, lineComments, picked });
  }, [runId, comment, lineComments, picked]);
  return { comment, setComment, lineComments, setLineComments, picked, setPicked };
}
