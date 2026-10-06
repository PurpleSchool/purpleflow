import { Archive, ClipboardCheck, FlaskConical, Hammer, Map as MapIcon, ScanEye, UserRoundCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import type { StageId } from '@psflow/core';

/** У каждой стадии всегда своя иконка; статус — цветом узла и значком в углу. */
export const STAGE_ICON: Record<StageId, ReactNode> = {
  plan: <MapIcon size={16} />,
  gate1: <UserRoundCheck size={16} />,
  implement: <Hammer size={16} />,
  tests: <FlaskConical size={16} />,
  review: <ScanEye size={16} />,
  gate2: <ClipboardCheck size={16} />,
  limit: <UserRoundCheck size={16} />,
  finish: <Archive size={16} />,
};
