import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("meetingCopilot", {
  getState: () => ipcRenderer.invoke("app-state"),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("app-state", listener);
    return () => ipcRenderer.removeListener("app-state", listener);
  },
  action: (action: string) => ipcRenderer.invoke("app-action", action),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("app-save-settings", settings),
  listContext: () => ipcRenderer.invoke("app-context-list"),
  getContextText: () => ipcRenderer.invoke("app-context-text-get"),
  saveContextText: (text: string) => ipcRenderer.invoke("app-context-text-save", text),
  addContext: () => ipcRenderer.invoke("app-context-add"),
  removeContext: (id: string) => ipcRenderer.invoke("app-context-remove", id),
});
