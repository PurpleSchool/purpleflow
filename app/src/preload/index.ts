import '@sentry/electron/preload';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { coreMethodNames, type CoreApi, type CoreMethod, type PurpleFlowBridge } from '../shared/ipc';
import type { CoreEvent } from '@purpleflow/core';
import type { UpdateState } from '../shared/update';

const call =
  (method: CoreMethod) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke('core:call', method, args);

const bridge: PurpleFlowBridge = {
  reportsErrors: ipcRenderer.sendSync('app:error-reports:get') === true,
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
    initialBalance: () => ipcRenderer.invoke('account:initialBalance'),
    requestEmailCode: () => ipcRenderer.invoke('account:requestEmailCode'),
    confirmEmailCode: (code) => ipcRenderer.invoke('account:confirmEmailCode', code),
    claimInitialBalance: () => ipcRenderer.invoke('account:claimInitialBalance'),
    trialModels: () => ipcRenderer.invoke('account:trialModels'),
    mediaModels: () => ipcRenderer.invoke('account:mediaModels'),
    paidBalance: () => ipcRenderer.invoke('account:paidBalance'),
    autoKey: () => ipcRenderer.invoke('account:autoKey'),
    overview: () => ipcRenderer.invoke('account:overview'),
    usage: (q) => ipcRenderer.invoke('account:usage', q),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    encryptionAvailable: () => ipcRenderer.invoke('settings:encryption'),
    onRecovered(fn) {
      const h = () => fn();
      ipcRenderer.on('settings:recovered', h);
      return () => ipcRenderer.removeListener('settings:recovered', h);
    },
  },
  proxyModels: () => ipcRenderer.invoke('models:list'),
  pickFolder: (title?: string) => ipcRenderer.invoke('dialog:folder', title),
  trashSkill: (paths: string[]) => ipcRenderer.invoke('skills:trash', paths),
  dictation: {
    status: () => ipcRenderer.invoke('dictation:status'),
    download: (id) => ipcRenderer.invoke('dictation:download', id),
    cancel: (id) => ipcRenderer.invoke('dictation:cancel', id),
    remove: (id) => ipcRenderer.invoke('dictation:remove', id),
    mic: () => ipcRenderer.invoke('dictation:mic'),
    transcribe: (wav, model, lang) => ipcRenderer.invoke('dictation:transcribe', wav, model, lang),
    onProgress(fn) {
      const h = (_: unknown, id: string, share: number) => fn(id, share);
      ipcRenderer.on('dictation:progress', h);
      return () => ipcRenderer.removeListener('dictation:progress', h);
    },
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  pickFile: () => ipcRenderer.invoke('dialog:file'),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  previewEmulate: (id, mobile) => ipcRenderer.invoke('preview:emulate', id, mobile),
  onPreviewNewTab(fn) {
    const h = (_: unknown, fromId: number, url: string) => fn(fromId, url);
    ipcRenderer.on('preview:new-tab', h);
    return () => ipcRenderer.removeListener('preview:new-tab', h);
  },
  terminal: {
    open: (o) => ipcRenderer.invoke('term:open', o),
    // Ввод — без ответа: печать не должна ждать main.
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    onData(fn) {
      const h = (_: unknown, id: number, data: string) => fn(id, data);
      ipcRenderer.on('term:data', h);
      return () => ipcRenderer.removeListener('term:data', h);
    },
    onExit(fn) {
      const h = (_: unknown, id: number, code: number) => fn(id, code);
      ipcRenderer.on('term:exit', h);
      return () => ipcRenderer.removeListener('term:exit', h);
    },
  },
  mediaFetch: (url) => ipcRenderer.invoke('media:fetch', url),
  mediaSave: (data, name) => ipcRenderer.invoke('media:save', { data, name }),
  chatWebTab: (chatId, id, reqId) => ipcRenderer.invoke('chatweb:tab', chatId, id, reqId),
  onChatWeb(fn) {
    const open = (_: unknown, chatId: string, url: string, reqId: string) => fn({ type: 'open', chatId, url, reqId });
    const close = (_: unknown, chatId: string, targetId: string) => fn({ type: 'close', chatId, targetId });
    const select = (_: unknown, chatId: string, targetId: string) => fn({ type: 'select', chatId, targetId });
    const size = (_: unknown, chatId: string, targetId: string, width: number, height: number) =>
      fn({ type: 'size', chatId, targetId, width, height });
    ipcRenderer.on('chatweb:size', size);
    ipcRenderer.on('chatweb:open', open);
    ipcRenderer.on('chatweb:close', close);
    ipcRenderer.on('chatweb:select', select);
    return () => {
      ipcRenderer.removeListener('chatweb:size', size);
      ipcRenderer.removeListener('chatweb:open', open);
      ipcRenderer.removeListener('chatweb:close', close);
      ipcRenderer.removeListener('chatweb:select', select);
    };
  },
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
  setupStep: (step, reason) => ipcRenderer.send('usage:setup', step, reason),
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
  reportBug: (tools) => ipcRenderer.invoke('app:reportBug', tools),
  whatsNew: {
    releases: () => ipcRenderer.invoke('whatsNew:releases'),
    versions: () => ipcRenderer.invoke('whatsNew:versions'),
    seen: () => ipcRenderer.invoke('whatsNew:seen'),
  },
  platform: process.platform,
  material: ipcRenderer.sendSync('app:material:get'),
  theme: ipcRenderer.sendSync('app:theme:get'),
  onMaterial(fn) {
    const h = (_: unknown, m: 'vibrancy' | 'acrylic' | 'none') => fn(m);
    ipcRenderer.on('app:material', h);
    return () => ipcRenderer.removeListener('app:material', h);
  },
};

contextBridge.exposeInMainWorld('purpleflow', bridge);
