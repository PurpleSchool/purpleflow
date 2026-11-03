import { useState } from 'react';
import type { LineComment, ReviewItem } from '@purpleflow/core';

/**
 * Состояние решения на гейте: комментарий, замечания по строкам, отмеченные к исправлению замечания ревьюера,
 * вкладка приёмки. Экран прогона пересоздаётся для каждого прогона (key в App), поэтому состояние не переносится.
 */
export function useRunGate() {
  const [comment, setComment] = useState('');
  const [lineComments, setLineComments] = useState<LineComment[]>([]);
  const [picked, setPicked] = useState<ReviewItem[]>([]);
  const [accTab, setAccTab] = useState<'code' | 'notes'>('code');
  return { comment, setComment, lineComments, setLineComments, picked, setPicked, accTab, setAccTab };
}
