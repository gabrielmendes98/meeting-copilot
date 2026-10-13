import { contextBridge, ipcRenderer } from "electron";
import type { OverlayState } from "./types";

contextBridge.exposeInMainWorld("copilot", {
  onState(callback: (state: OverlayState) => void) {
    ipcRenderer.on("overlay-state", (_event, state: OverlayState) => {
      callback(state);
    });
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
