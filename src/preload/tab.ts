import { contextBridge, ipcRenderer } from 'electron';
import type { TabApi } from '../shared/types.ts';

const api: TabApi = {
  setProject: (id) => ipcRenderer.send('tab:project', id),
  openProject: (id) => ipcRenderer.invoke('tab:open', id) as Promise<'ok' | 'focused'>,
  newTab: () => ipcRenderer.send('tab:new'),
  openPath: (which, projectId) => ipcRenderer.send('app:open-path', which, projectId),
  onSettings: (cb) => {
    ipcRenderer.on('tab:settings', (_e, section: string | null) => cb(section));
  },
  onDeleteProject: (cb) => {
    ipcRenderer.on('tab:delete-project', () => cb());
  },
};

contextBridge.exposeInMainWorld('kilnTab', api);
