import { Bug, Layers, Rocket, Shuffle, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Mode } from '../lib/stages';

export const MODE_ICON: Record<Mode, ReactNode> = {
  quick: <Zap size={15} />,
  bug: <Bug size={15} />,
  task: <Rocket size={15} />,
  epic: <Layers size={15} />,
  refactor: <Shuffle size={15} />,
};
