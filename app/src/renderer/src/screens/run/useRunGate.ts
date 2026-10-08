import { useEffect, useState } from 'react';
import type { LineComment, ReviewItem } from '@psflow/core';

/**
 * Состояние решения на гейте: комментарий, замечания по строкам, отмеченные к исправлению замечания ревьюера,
 * вкладка приёмки. Сбрасывается целиком при переходе к другому прогону.
 */
export function useRunGate(runId: string) {
  const [comment, setComment] = useState('');
  const [lineComments, setLineComments] = useState<LineComment[]>([]);
  const [picked, setPicked] = useState<ReviewItem[]>([]);
  const [accTab, setAccTab] = useState<'code' | 'notes'>('code');
  useEffect(() => {
    setComment('');
    setLineComments([]);
    setPicked([]);
    setAccTab('code');
  }, [runId]);
  return { comment, setComment, lineComments, setLineComments, picked, setPicked, accTab, setAccTab };
}
