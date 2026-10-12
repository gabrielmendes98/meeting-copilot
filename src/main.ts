import fs from "node:fs";
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
  screen,
  Tray,
} from "electron";
import { SystemAudioCapture } from "./capture";
import {
  askFromScreenshot,
  askFromTranscript,
  disposeAgent,
  emptyReply,
  overlayLabel,
  warmAgent,
  type TranscriptMode,
} from "./agent";
import {
  briefingHotkey,
  checkpointHotkey,
  hotkey,
  loadEnv,
  missingKeys,
  missingAgentKeys,
  screenshotHotkey,
  summaryHotkey,
} from "./env";
import { MacosLiveSession } from "./live-session";
import { captureRegion } from "./screenshot";
import { pickProvider, transcribeWav } from "./transcribe";
import { assertWavHasAudio } from "./wav";
import type { OverlayState, OverlayStatus } from "./types";

let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let busy = false;
const capture = new SystemAudioCapture();
const liveSession = new MacosLiveSession();

function overlayPath(): string {
  return `${__dirname}/overlay/index.html`;
}

function listeningActive(): boolean {
  return liveSession.active || capture.active;
}

function sendState(status: OverlayStatus, text = "", label?: string): void {
  const state: OverlayState = { status, text, label };
  overlay?.webContents.send("overlay-state", state);
  if (status === "hidden") {
    overlay?.hide();
    setTrayRecording(listeningActive());
    return;
  }
  overlay?.showInactive();
  setTrayRecording(listeningActive() || status === "recording");
}

function displayHotkey(accelerator: string): string {
  return accelerator.replaceAll("Alt+", "Option+");
}

function idleTooltip(): string {
  return `Meeting Copilot — ${displayHotkey(hotkey())} record · ${displayHotkey(checkpointHotkey())} answer · ${displayHotkey(screenshotHotkey())} screenshot`;
}

function listeningHint(): string {
  return `${displayHotkey(hotkey())} stops · ${displayHotkey(checkpointHotkey())} answer · ${displayHotkey(summaryHotkey())} summary · ${displayHotkey(briefingHotkey())} notes`;
}

function setTrayRecording(recording: boolean): void {
  if (!tray) return;
  tray.setTitle(recording ? "●" : "");
  tray.setToolTip(
    recording
      ? liveSession.active
        ? "Meeting Copilot — listening"
        : "Meeting Copilot — recording"
      : idleTooltip(),
  );
}

function refreshTray(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
  setTrayRecording(listeningActive());
}

function loadTrayIcon(): NativeImage {
  const png = `${__dirname}/assets/trayTemplate@2x.png`;
  if (!fs.existsSync(png)) {
    return nativeImage.createEmpty();
  }
  const image = nativeImage.createFromBuffer(fs.readFileSync(png), {
    scaleFactor: 2,
  });
  image.setTemplateImage(true);
  return image;
}

const OVERLAY_WIDTH = 840;
const OVERLAY_MIN_HEIGHT = 140;

function overlayMaxHeight(): number {
  return Math.round(screen.getPrimaryDisplay().workAreaSize.height * 0.55);
}

function resizeOverlay(contentHeight: number): void {
  if (!overlay) return;
  const height = Math.min(
    overlayMaxHeight(),
    Math.max(OVERLAY_MIN_HEIGHT, Math.ceil(contentHeight)),
  );
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
  const bounds = overlay.getBounds();
  overlay.setBounds({
    x: Math.round((screenWidth - OVERLAY_WIDTH) / 2),
    y: bounds.y,
    width: OVERLAY_WIDTH,
    height,
  });
}

function createOverlay(): BrowserWindow {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_MIN_HEIGHT,
    x: Math.round((width - OVERLAY_WIDTH) / 2),
    y: 52,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: `${__dirname}/preload.js`,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(overlayPath());
  win.on("closed", () => {
    overlay = null;
  });
  return win;
}

function trayTemplate(): MenuItemConstructorOptions[] {
  return [
    { label: "Meeting Copilot", enabled: false },
    { label: `Record: ${displayHotkey(hotkey())}`, enabled: false },
    { label: `Answer: ${displayHotkey(checkpointHotkey())}`, enabled: false },
    { label: `Summary: ${displayHotkey(summaryHotkey())}`, enabled: false },
    { label: `Notes: ${displayHotkey(briefingHotkey())}`, enabled: false },
    {
      label: `Screenshot: ${displayHotkey(screenshotHotkey())}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Stop listening",
      enabled: liveSession.active,
      click: () => {
        void stopListening();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ];
}

function createTray(): Tray {
  const next = new Tray(loadTrayIcon());
  next.setToolTip(idleTooltip());
  next.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
  tray = next;
  return next;
}

function hideOverlay(): void {
  sendState("hidden");
}

async function stopListening(): Promise<void> {
  await liveSession.stop();
  refreshTray();
  hideOverlay();
}

async function askAndShow(
  transcript: string,
  mode: TranscriptMode,
): Promise<void> {
  const label = overlayLabel(mode);
  if (!transcript.trim()) {
    sendState("answer", emptyReply(mode), label);
    return;
  }
  sendState("thinking", "Thinking…");
  const answer = await askFromTranscript(
    transcript,
    (full) => {
      sendState("answer", full, label);
    },
    { mode },
  );
  sendState("answer", answer || emptyReply(mode), label);
}

async function toggleMacosLive(): Promise<void> {
  if (busy) return;

  if (!liveSession.active) {
    if (!checkConfiguration()) return;
    sendState("recording", `Listening… ${listeningHint()}.`);
    busy = true;
    try {
      await liveSession.start();
      refreshTray();
    } catch (err) {
      refreshTray();
      sendState("error", err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
    return;
  }

  await stopListening();
}

async function runMacosAction(mode: TranscriptMode): Promise<void> {
  if (busy) return;
  if (!liveSession.active) {
    sendState(
      "error",
      `Start listening with ${displayHotkey(hotkey())} first.`,
    );
    return;
  }

  busy = true;
  try {
    sendState("transcribing", "Transcribing…");
    const transcript = await liveSession.flushAndTranscript();
    await askAndShow(transcript, mode);
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally {
    busy = false;
  }
}

async function runClipAction(mode: TranscriptMode): Promise<void> {
  if (busy) return;
  if (!capture.active) {
    sendState(
      "error",
      `Start recording with ${displayHotkey(hotkey())} first.`,
    );
    return;
  }

  busy = true;
  let wavPath: string | null = null;
  try {
    sendState("transcribing", "Transcribing…");
    wavPath = await capture.stop();
    refreshTray();
    assertWavHasAudio(wavPath);
    const transcript = await transcribeWav(wavPath);
    await askAndShow(transcript, mode === "checkpoint" ? "clip" : mode);
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally {
    if (wavPath) {
      try {
        fs.unlinkSync(wavPath);
      } catch {
        // ignore
      }
    }
    busy = false;
  }
}

function runTranscriptAction(mode: TranscriptMode): void {
  if (pickProvider() === "macos") {
    void runMacosAction(mode);
    return;
  }
  void runClipAction(mode);
}

async function toggleCapture(): Promise<void> {
  if (pickProvider() === "macos") {
    await toggleMacosLive();
    return;
  }

  if (busy) return;

  if (!capture.active) {
    if (!checkConfiguration()) return;
    try {
      await capture.start();
      sendState("recording", `Recording… ${listeningHint()}.`);
    } catch (err) {
      sendState("error", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  try {
    const wavPath = await capture.stop();
    refreshTray();
    hideOverlay();
    try {
      fs.unlinkSync(wavPath);
    } catch {
      // ignore
    }
  } catch (err) {
    refreshTray();
    sendState("error", err instanceof Error ? err.message : String(err));
  }
}

async function toggleScreenshot(): Promise<void> {
  if (busy) return;

  if (!checkConfiguration(true)) return;

  hideOverlay();
  busy = true;
  let pngPath: string | null = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    pngPath = await captureRegion();
    if (!pngPath) return;
    sendState("thinking", "Reading the screenshot…");
    const answer = await askFromScreenshot(pngPath, (full) => {
      sendState("answer", full);
    });
    const text = answer || "The request wasn't clear.";
    sendState("answer", text);
    clipboard.writeText(text);
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally {
    if (pngPath) {
      try {
        fs.unlinkSync(pngPath);
      } catch {
        // ignore
      }
    }
    busy = false;
  }
}

function checkConfiguration(agentOnly = false): boolean {
  try {
    const missing = agentOnly ? missingAgentKeys() : missingKeys();
    if (missing.length) throw new Error(`Set these in .env: ${missing.join(", ")}. See .env.example.`);
    return true;
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
    return false;
  }
}

function registerHotkey(accelerator: string, handler: () => void): void {
  const ok = globalShortcut.register(accelerator, handler);
  if (!ok) {
    sendState(
      "error",
      `Could not register hotkey ${accelerator}. Close any app using the same shortcut.`,
    );
  }
}

function registerHotkeys(): void {
  registerHotkey(hotkey(), () => {
    void toggleCapture();
  });
  registerHotkey(checkpointHotkey(), () => {
    runTranscriptAction("checkpoint");
  });
  registerHotkey(summaryHotkey(), () => {
    runTranscriptAction("summary");
  });
  registerHotkey(briefingHotkey(), () => {
    runTranscriptAction("briefing");
  });
  registerHotkey(screenshotHotkey(), () => {
    void toggleScreenshot();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    overlay?.showInactive();
  });

  app.whenReady().then(async () => {
    loadEnv();
    if (process.platform === "darwin") {
      app.dock?.hide();
    }
    overlay = createOverlay();
    createTray();
    liveSession.onUnexpectedExit = (err) => {
      refreshTray();
      sendState("error", err.message);
    };
    ipcMain.on("overlay-dismiss", hideOverlay);
    ipcMain.on("overlay-height", (_event, height: number) => {
      if (typeof height === "number" && Number.isFinite(height)) {
        resizeOverlay(height);
      }
    });
    registerHotkeys();
    if (checkConfiguration(true)) {
      try {
        await warmAgent();
      } catch (err) {
        console.error("Failed to warm the agent:", err);
      }
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    capture.kill();
    void liveSession.stop();
    void disposeAgent();
  });
}
