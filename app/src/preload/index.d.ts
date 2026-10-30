import type { PurpleFlowBridge } from '../shared/ipc';

declare global {
  interface Window {
    purpleflow: PurpleFlowBridge;
  }
}
