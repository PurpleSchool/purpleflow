import { contextBridge, ipcRenderer } from 'electron';
import type { CoreApi, CoreMethod, PsFlowBridge } from '../shared/ipc';
import type { CoreEvent } from '@psflow/core';

const call = (method: CoreMethod) => (...args: unknown[]) => ipcRenderer.invoke('core:call', method, args);

const methods: CoreMethod[] = [
  'dispatch', 'listRuns', 'getRun', 'getLog', 'getDiff', 'getChangeDocs', 'detectTools', 'testConnection', 'detectProject', 'isDriving', 'listBranches', 'getAttachment', 'detectCommandsAI', 'getProjectConfig', 'saveProjectConfig',
];

const bridge: PsFlowBridge = {
  core: Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as CoreApi,
  onEvent(fn) {
    const h = (_: unknown, e: CoreEvent) => fn(e);
    ipcRenderer.on('core:event', h);
    return () => ipcRenderer.removeListener('core:event', h);
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    encryptionAvailable: () => ipcRenderer.invoke('settings:encryption'),
  },
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickFile: () => ipcRenderer.invoke('dialog:file'),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  platform: process.platform,
  material: ipcRenderer.sendSync('app:material:get'),
  onMaterial(fn) {
    const h = (_: unknown, m: 'vibrancy' | 'acrylic' | 'none') => fn(m);
    ipcRenderer.on('app:material', h);
    return () => ipcRenderer.removeListener('app:material', h);
  },
};

contextBridge.exposeInMainWorld('psflow', bridge);
