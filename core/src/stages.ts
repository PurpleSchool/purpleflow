// Названия стадий и гейты.

import type { StageId } from './types.js';

export const STAGE_TITLES: Record<StageId, string> = {
  clarify: 'Уточнение',
  gate0: 'Ответы на вопросы',
  plan: 'План',
  gate1: 'Утверждение плана',
  implement: 'Реализация',
  tests: 'Проверки',
  baseline: 'Базовые проверки',
  visual: 'Визуальная проверка',
  review: 'Ревью',
  gate2: 'Приёмка',
  limit: 'Нужно решение',
  finish: 'Завершение',
};

export function isGate(s: StageId): boolean {
  return s === 'gate0' || s === 'gate1' || s === 'gate2' || s === 'limit';
}
