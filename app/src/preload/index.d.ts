import type { PsFlowBridge } from '../shared/ipc';

declare global {
  interface Window {
    psflow: PsFlowBridge;
  }
}
