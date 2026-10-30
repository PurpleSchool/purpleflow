import {
  Archive,
  ClipboardCheck,
  MessageCircleQuestion,
  FlaskConical,
  Hammer,
  Map as MapIcon,
  MonitorCheck,
  ScanEye,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { StageId } from '@purpleflow/core';

/** У каждой стадии всегда своя иконка; статус — цветом узла и значком в углу. */
export const STAGE_ICON: Record<StageId, ReactNode> = {
  baseline: <ShieldCheck size={16} />,
  clarify: <MessageCircleQuestion size={16} />,
  gate0: <MessageCircleQuestion size={16} />,
  visual: <MonitorCheck size={16} />,
  plan: <MapIcon size={16} />,
  gate1: <UserRoundCheck size={16} />,
  implement: <Hammer size={16} />,
  tests: <FlaskConical size={16} />,
  review: <ScanEye size={16} />,
  gate2: <ClipboardCheck size={16} />,
  limit: <UserRoundCheck size={16} />,
  finish: <Archive size={16} />,
};
