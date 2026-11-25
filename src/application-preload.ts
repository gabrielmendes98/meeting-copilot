import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("meetingCopilot", {
  getState: () => ipcRenderer.invoke("app-state"),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("app-state", listener);
    return () => ipcRenderer.removeListener("app-state", listener);
  },
  action: (action: string) => ipcRenderer.invoke("app-action", action),
  ask: (question: string, screen: boolean, smart: boolean) => ipcRenderer.invoke("app-chat", question, screen, smart),
  setScreenContext: (enabled: boolean) => ipcRenderer.invoke("app-screen-context", enabled),
  onAskShortcut: (callback: () => void) => { ipcRenderer.on("app-ask-shortcut", () => callback()); },
  onNewChat: (callback: () => void) => { ipcRenderer.on("app-new-chat", () => callback()); },
  onOpenPage: (callback: (page: string) => void) => { ipcRenderer.on("app-open-page", (_event, page: string) => callback(page)); },
  cancelChat: () => ipcRenderer.invoke("app-chat-cancel"),
  clearChat: () => ipcRenderer.invoke("app-chat-clear"),
  permissions: () => ipcRenderer.invoke("app-permissions"),
  requestMicrophone: () => ipcRenderer.invoke("app-request-microphone"),
  onModeChanged: (callback: (modes: unknown) => void) => { ipcRenderer.on("app-mode-changed", (_event, modes: unknown) => callback(modes)); },
  listModes: () => ipcRenderer.invoke("app-mode-list"),
  updateMode: (action: string, id: string | null, title?: string, instructions?: string, references?: string[] | null) => ipcRenderer.invoke("app-mode-update", action, id, title, instructions, references),
  listMeetings: (query: string) => ipcRenderer.invoke("app-history-list", query),
  getMeeting: (id: string) => ipcRenderer.invoke("app-history-get", id),
  editMeeting: (id: string, title: string, notes: string) => ipcRenderer.invoke("app-history-edit", id, title, notes),
  deleteMeeting: (id: string) => ipcRenderer.invoke("app-history-delete", id),
  exportMeeting: (id: string, copy = false) => ipcRenderer.invoke("app-history-export", id, copy),
  generateNotes: (id: string) => ipcRenderer.invoke("app-history-notes", id),
  askHistory: (id: string | null, question: string, query: string) => ipcRenderer.invoke("app-history-ask", id, question, query),
  onHistoryChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("app-history-changed", listener);
    return () => ipcRenderer.removeListener("app-history-changed", listener);
  },
  saveSettings: (settings: unknown) => ipcRenderer.invoke("app-save-settings", settings),
  listContext: () => ipcRenderer.invoke("app-context-list"),
  getContextText: () => ipcRenderer.invoke("app-context-text-get"),
  saveContextText: (text: string) => ipcRenderer.invoke("app-context-text-save", text),
  addContext: () => ipcRenderer.invoke("app-context-add"),
  removeContext: (id: string) => ipcRenderer.invoke("app-context-remove", id),
});
