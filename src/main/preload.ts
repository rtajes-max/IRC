import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = new Set([
  'snapshot', 'input', 'setActive', 'typing', 'closeBuffer', 'connect', 'network:remove', 'settings:update',
  'scripts:list', 'scripts:save', 'scripts:delete', 'logs:search', 'dcc:accept', 'dcc:reject', 'dcc:chat', 'dcc:send',
  'dcc:reveal', 'menu:get', 'menu:run',
]);

contextBridge.exposeInMainWorld('onda', {
  invoke(channel: string, ...args: unknown[]) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error('canal no permitido'));
    return ipcRenderer.invoke(channel, ...args);
  },
  onUi(cb: (ev: unknown) => void) {
    ipcRenderer.on('ui', (_e, ev) => cb(ev));
  },
});
