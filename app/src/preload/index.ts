import { contextBridge, ipcRenderer } from 'electron';
import { coreMethodNames, type CoreApi, type CoreMethod, type PurpleFlowBridge } from '../shared/ipc';
import type { CoreEvent } from '@purpleflow/core';
import type { UpdateState } from '../shared/update';

const call =
  (method: CoreMethod) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke('core:call', method, args);

const bridge: PurpleFlowBridge = {
  core: Object.fromEntries(coreMethodNames.map((m) => [m, call(m)])) as unknown as CoreApi,
  onEvent(fn) {
    const h = (_: unknown, e: CoreEvent) => fn(e);
    ipcRenderer.on('core:event', h);
    return () => ipcRenderer.removeListener('core:event', h);
  },
  account: {
    login: (email, password) => ipcRenderer.invoke('account:login', email, password),
    register: (p) => ipcRenderer.invoke('account:register', p),
    restore: (email) => ipcRenderer.invoke('account:restore', email),
    logout: () => ipcRenderer.invoke('account:logout'),
    profile: () => ipcRenderer.invoke('account:profile'),
    keys: () => ipcRenderer.invoke('account:keys'),
    createKey: () => ipcRenderer.invoke('account:createKey'),
    useKey: (id) => ipcRenderer.invoke('account:useKey', id),
    autoKey: () => ipcRenderer.invoke('account:autoKey'),
    overview: () => ipcRenderer.invoke('account:overview'),
    usage: (q) => ipcRenderer.invoke('account:usage', q),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    encryptionAvailable: () => ipcRenderer.invoke('settings:encryption'),
  },
  pickFolder: (title?: string) => ipcRenderer.invoke('dialog:folder', title),
  pickFile: () => ipcRenderer.invoke('dialog:file'),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  previewEmulate: (id, mobile) => ipcRenderer.invoke('preview:emulate', id, mobile),
  appCache: { size: () => ipcRenderer.invoke('cache:size'), clear: () => ipcRenderer.invoke('cache:clear') },
  onChime(fn) {
    const h = () => fn();
    ipcRenderer.on('app:chime', h);
    return () => ipcRenderer.removeListener('app:chime', h);
  },
  onGo(fn) {
    const h = (_: unknown, id: string) => fn(id);
    ipcRenderer.on('app:go', h);
    return () => ipcRenderer.removeListener('app:go', h);
  },
  testNotification: () => ipcRenderer.invoke('notify:test'),
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    onState(fn) {
      const h = (_: unknown, u: UpdateState) => fn(u);
      ipcRenderer.on('update:state', h);
      return () => ipcRenderer.removeListener('update:state', h);
    },
    onReveal(fn) {
      const h = () => fn();
      ipcRenderer.on('update:reveal', h);
      return () => ipcRenderer.removeListener('update:reveal', h);
    },
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
  },
  platform: process.platform,
  material: ipcRenderer.sendSync('app:material:get'),
  onMaterial(fn) {
    const h = (_: unknown, m: 'vibrancy' | 'acrylic' | 'none') => fn(m);
    ipcRenderer.on('app:material', h);
    return () => ipcRenderer.removeListener('app:material', h);
  },
};

contextBridge.exposeInMainWorld('purpleflow', bridge);
