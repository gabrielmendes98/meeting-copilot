import { contextBridge, ipcRenderer } from "electron";
import type { OverlayState } from "./types";

contextBridge.exposeInMainWorld("copilot", {
  onState(callback: (state: OverlayState) => void) {
    ipcRenderer.on("overlay-state", (_event, state: OverlayState) => {
      callback(state);
    });
  },
  onSession(callback: (session: unknown) => void) {
    ipcRenderer.on("overlay-session", (_event, session: unknown) => callback(session));
  },
  action(action: string, question?: string, screen?: boolean) {
    return ipcRenderer.invoke("overlay-action", action, question, screen);
  },
  onAskShortcut(callback: () => void) {
    ipcRenderer.on("overlay-ask-shortcut", () => callback());
  },
  onFocusComposer(callback: () => void) {
    ipcRenderer.on("overlay-focus-composer", () => callback());
  },
  onNewChat(callback: () => void) {
    ipcRenderer.on("overlay-new-chat", () => callback());
  },
  dismiss() {
    ipcRenderer.send("overlay-dismiss");
  },
  onScroll(callback: (distance: number) => void) {
    ipcRenderer.on("overlay-scroll", (_event, distance: number) => callback(distance));
  },
  resize(height: number) {
    ipcRenderer.send("overlay-height", height);
  },
});
