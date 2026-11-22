import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { AppCore } from '../core/app';
import type { NetworkConfig, Settings, UiEvent } from '../core/types';

let win: BrowserWindow | null = null;
let core: AppCore;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: 'Onda IRC',
    backgroundColor: '#14171c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Los enlaces del chat se abren en el navegador del sistema, nunca dentro de la aplicación.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  const dataDir = process.env.ONDA_DATA_DIR || app.getPath('userData');
  core = new AppCore({
    dataDir,
    downloadsDir: process.env.ONDA_DATA_DIR ? path.join(dataDir, 'descargas') : path.join(app.getPath('downloads'), 'Onda IRC'),
    version: `Onda IRC ${app.getVersion()}`,
  });
  core.on('ui', (ev: UiEvent) => win?.webContents.send('ui', ev));

  const h = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));
  h('snapshot', () => core.snapshot());
  h('input', (sid: string, buffer: string, text: string) => core.input(String(sid), String(buffer), String(text)));
  h('setActive', (sid: string, buffer: string) => core.setActive(String(sid), String(buffer)));
  h('typing', (sid: string, buffer: string, state: 'active' | 'paused' | 'done') => core.typing(sid, buffer, state));
  h('closeBuffer', (sid: string, buffer: string) => core.closeBuffer(sid, buffer));
  h('connect', (cfg: NetworkConfig, save: boolean) => {
    if (save) core.saveNetwork(cfg);
    return core.connect(cfg);
  });
  h('network:remove', (name: string) => core.removeNetwork(name));
  h('settings:update', (patch: Partial<Settings>) => core.updateSettings(patch));
  h('scripts:list', () => core.listScripts());
  h('scripts:save', (name: string, source: string) => core.saveScript(String(name), String(source)));
  h('scripts:delete', (name: string) => core.deleteScript(String(name)));
  h('menu:get', (sid: string, buffer: string, nick?: string) => core.scriptMenu(String(sid), String(buffer), nick ? String(nick) : undefined));
  h('menu:run', (id: string, sid: string, buffer: string, nick?: string) =>
    core.runScriptMenu(String(id), String(sid), String(buffer), nick ? String(nick) : undefined));
  h('logs:search', (q: string) => core.searchLogs(String(q)));
  h('dcc:accept', (id: string) => core.dccAccept(id));
  h('dcc:reject', (id: string) => core.dccReject(id));
  h('dcc:chat', (sid: string, nick: string) => core.dccChat(sid, nick));
  h('dcc:send', async (sid: string, nick: string) => {
    if (!win) return;
    const r = await dialog.showOpenDialog(win, { title: `Enviar archivo a ${nick}`, properties: ['openFile'] });
    if (!r.canceled && r.filePaths[0]) await core.dccSend(sid, nick, r.filePaths[0]);
  });
  h('dcc:reveal', (id: string) => {
    const d = core.snapshot().dccs.find((x) => x.id === id);
    if (d?.path) shell.showItemInFolder(d.path);
  });

  createWindow();
  for (const n of core.networks) if (n.autoconnect) core.connect(n);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  core?.shutdown();
  app.quit();
});
