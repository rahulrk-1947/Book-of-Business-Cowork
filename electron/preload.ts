import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bridge', {
  api: (path: string, ...args: unknown[]) => ipcRenderer.invoke('api', path, args),
  exportPdf: (html: string, name: string) => ipcRenderer.invoke('export-pdf', html, name),
  saveCsv: (csv: string, name: string) => ipcRenderer.invoke('save-csv', csv, name),
  backup: () => ipcRenderer.invoke('backup'),
  restore: () => ipcRenderer.invoke('restore'),
});
