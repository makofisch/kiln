import { contextBridge, ipcRenderer } from 'electron';
import type { MenuItem, ShellApi, ShellState } from '../shared/types.ts';

const api: ShellApi = {
  onState: (cb) => {
    ipcRenderer.on('shell:state', (_e, s: ShellState) => cb(s));
    ipcRenderer.send('shell:ready');
  },
  onNotice: (cb) => {
    ipcRenderer.on('shell:notice', (_e, text: string) => cb(text));
  },
  newTab: () => ipcRenderer.send('shell:new'),
  activate: (id) => ipcRenderer.send('shell:activate', id),
  close: (id) => ipcRenderer.send('shell:close', id),
  dropTab: (id, x, y, index) => ipcRenderer.send('shell:drop', id, x, y, index),
  detach: (id) => ipcRenderer.send('shell:detach', id),
  tabMenu: (id, titles) => ipcRenderer.send('shell:tabmenu', id, titles),
  popup: (items: MenuItem[]) => ipcRenderer.invoke('shell:popup', items) as Promise<string | null>,
  setTitle: (title) => ipcRenderer.send('shell:title', title),
  openPath: (which) => ipcRenderer.send('app:open-path', which),
  dragStart: (id) => ipcRenderer.send('shell:drag-start', id),
  dragEnd: (index) => ipcRenderer.send('shell:drag-end', index),
  toggleMaximize: () => ipcRenderer.send('shell:toggle-max'),
  setWorking: (working) => ipcRenderer.send('shell:working', working),
  openSettings: (section) => ipcRenderer.send('shell:settings', section ?? null),
};

contextBridge.exposeInMainWorld('kilnShell', api);
