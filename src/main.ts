import fs from "node:fs";
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  type NativeImage,
  screen,
  Tray,
} from "electron";
import { SystemAudioCapture } from "./capture";
import {
  askFromScreenshot,
  askFromTranscript,
  disposeAgent,
  warmAgent,
} from "./agent";
import { hotkey, loadEnv, missingKeys, screenshotHotkey } from "./env";
import { captureRegion } from "./screenshot";
import { transcribeWav } from "./transcribe";
import { assertWavHasAudio } from "./wav";
import type { OverlayState, OverlayStatus } from "./types";

let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let busy = false;
const capture = new SystemAudioCapture();

function overlayPath(): string {
  return `${__dirname}/overlay/index.html`;
}

function sendState(status: OverlayStatus, text = ""): void {
  const state: OverlayState = { status, text };
  overlay?.webContents.send("overlay-state", state);
  if (status === "hidden") {
    overlay?.hide();
    setTrayRecording(false);
    return;
  }
  overlay?.showInactive();
  setTrayRecording(status === "recording");
}

function displayHotkey(accelerator: string): string {
  return accelerator.replaceAll("Alt+", "Option+");
}

function idleTooltip(): string {
  return `Meeting Copilot — ${displayHotkey(hotkey())} to record · ${displayHotkey(screenshotHotkey())} to screenshot`;
}

function setTrayRecording(recording: boolean): void {
  if (!tray) return;
  tray.setTitle(recording ? "●" : "");
  tray.setToolTip(
    recording ? "Meeting Copilot — recording" : idleTooltip(),
  );
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

function createTray(): Tray {
  const next = new Tray(loadTrayIcon());
  next.setToolTip(idleTooltip());
  next.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Meeting Copilot", enabled: false },
      { label: `Record: ${displayHotkey(hotkey())}`, enabled: false },
      {
        label: `Screenshot: ${displayHotkey(screenshotHotkey())}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  tray = next;
  return next;
}

function hideOverlay(): void {
  sendState("hidden");
}

async function toggleCapture(): Promise<void> {
  if (busy) return;

  if (!capture.active) {
    const missing = missingKeys();
    if (missing.length > 0) {
      sendState(
        "error",
        `Set these in .env: ${missing.join(", ")}. See .env.example.`,
      );
      return;
    }
    try {
      await capture.start();
      sendState(
        "recording",
        `Recording system audio. ${displayHotkey(hotkey())} to stop.`,
      );
    } catch (err) {
      sendState("error", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  busy = true;
  let wavPath: string | null = null;
  try {
    sendState("transcribing", "Transcribing…");
    wavPath = await capture.stop();
    assertWavHasAudio(wavPath);
    const transcript = await transcribeWav(wavPath);
    sendState("thinking", "Thinking…");
    const answer = await askFromTranscript(transcript, (full) => {
      sendState("answer", full);
    });
    sendState("answer", answer || "The request wasn't clear.");
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

async function toggleScreenshot(): Promise<void> {
  if (busy || capture.active) return;

  if (!process.env.CURSOR_API_KEY?.trim()) {
    sendState("error", "Set these in .env: CURSOR_API_KEY. See .env.example.");
    return;
  }

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
    ipcMain.on("overlay-dismiss", hideOverlay);
    ipcMain.on("overlay-height", (_event, height: number) => {
      if (typeof height === "number" && Number.isFinite(height)) {
        resizeOverlay(height);
      }
    });
    registerHotkeys();
    if (missingKeys().length === 0) {
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
    void disposeAgent();
  });
}
