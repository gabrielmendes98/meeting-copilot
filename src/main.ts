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
  resetAgent,
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
  stealthHotkey,
} from "./env";
import { captureRegion } from "./screenshot";
import { transcription, transcribeWav, resetTranscription, pickProvider } from "./transcribe";
import { loadSettings, publicSettings, saveSettings } from "./settings";
import { validateSettings, shortcutKeys } from "./settings-config";
import { addContextFiles, listContextFiles, removeContextFile, getContextText, saveContextText } from "./context-files";
import { assertWavHasAudio } from "./wav";
import type { OverlayState, OverlayStatus } from "./types";

let overlay: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let currentState: OverlayState = { status: "hidden", text: "" };
let latestReply = "";
let startupError = "";
let tray: Tray | null = null;
let busy = false;
let stealth = false;
let stealthTransition = false;
let stealthShortcutRegistered = false;
const capture = new SystemAudioCapture();

function overlayPath(): string {
  return `${__dirname}/overlay/index.html`;
}

function listeningActive(): boolean {
  return transcription.active || capture.active;
}

function sendState(status: OverlayStatus, text = "", label?: string): void {
  const state: OverlayState = { status, text, label, stealth, exitShortcut: displayHotkey(stealthHotkey()) };
  currentState = state;
  if (status === "answer") latestReply = text;
  publishAppState();
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
      ? transcription.active
        ? "Meeting Copilot — listening"
        : "Meeting Copilot — recording"
      : idleTooltip(),
  );
}

function refreshTray(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
  setTrayRecording(listeningActive());
  publishAppState();
}

function appState() {
  let configurationError = startupError;
  let live = false;
  try {
    live = pickProvider() === "macos";
    const missing = missingKeys();
    if (missing.length) configurationError ||= "Add your API keys in Settings to get started.";
  } catch (err) { configurationError = err instanceof Error ? err.message : String(err); }
  return { overlay: currentState, latestReply, busy, listening: listeningActive(),
    live, settings: publicSettings(), configurationError, stealth, stealthAvailable: process.platform === "darwin" && stealthShortcutRegistered };
}

function setBusy(value: boolean): void {
  busy = value;
  publishAppState();
}

function publishAppState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app-state", appState());
}

function openApplication(): void {
  if (stealth || stealthTransition) return;
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1120, height: 780, minWidth: 900, minHeight: 650,
      title: "Meeting Copilot", titleBarStyle: "hiddenInset", backgroundColor: "#f7f8fc",
      webPreferences: { preload: `${__dirname}/application-preload.js`, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    void mainWindow.loadFile(`${__dirname}/application/index.html`);
    mainWindow.on("closed", () => { mainWindow = null; });
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function setStealthMode(enabled: boolean): Promise<void> {
  if (stealthTransition || enabled === stealth) return;
  if (process.platform !== "darwin") throw new Error("Stealth mode currently supports macOS only.");
  if (enabled && !stealthShortcutRegistered) throw new Error("Configure an available stealth shortcut in Settings before enabling stealth mode.");
  stealthTransition = true;
  try {
    // Protect both windows before changing visibility. This is best effort on macOS.
    if (enabled) {
      mainWindow?.setContentProtection(true);
      overlay?.setContentProtection(true);
      overlay?.setFocusable(false);
      mainWindow?.setSkipTaskbar(true);
      stealth = true;
      mainWindow?.hide();
      tray?.destroy(); tray = null;
      app.setActivationPolicy("accessory");
      app.dock?.hide();
      if (!overlay) overlay = createOverlay();
      if (currentState.status === "hidden") {
        sendState("idle", `Stealth mode is on. ${displayHotkey(stealthHotkey())} restores the app.\n${displayHotkey(hotkey())} starts or stops listening. Screen-share invisibility is not guaranteed.`, "Stealth");
      } else { sendState(currentState.status, currentState.text, currentState.label); }
    } else {
      try {
        app.setActivationPolicy("regular");
        await app.dock?.show();
      } catch (error) {
        app.setActivationPolicy("accessory");
        app.dock?.hide();
        throw error;
      }
      mainWindow?.setContentProtection(false);
      overlay?.setContentProtection(false);
      overlay?.setFocusable(true);
      mainWindow?.setSkipTaskbar(false);
      stealth = false;
      if (!tray) createTray();
      refreshTray();
      if (currentState.status === "idle") hideOverlay();
      else sendState(currentState.status, currentState.text, currentState.label);
    }
  } finally { stealthTransition = false; publishAppState(); }
  if (!enabled) openApplication();
}

function toggleStealthMode(): void {
  void setStealthMode(!stealth).catch((error) => {
    sendState("error", error instanceof Error ? error.message : String(error));
  });
}

function hotkeyHandlers(): Array<() => void> {
  return [() => { void toggleCapture(); }, () => runTranscriptAction("checkpoint"), () => runTranscriptAction("summary"), () => runTranscriptAction("briefing"), () => { void toggleScreenshot(); }, toggleStealthMode];
}

function registerApplicationIpc(): void {
  function authorize(event: Electron.IpcMainInvokeEvent): void {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("Unauthorized window.");
  }
  ipcMain.handle("app-state", (event) => { authorize(event); return appState(); });
  ipcMain.handle("app-action", async (event, action: string) => {
    authorize(event);
    if (action === "stealth") { await setStealthMode(!stealth); return; }
    if (busy) return;
    if (action === "capture") await toggleCapture();
    else if (action === "screenshot") await toggleScreenshot();
    else if (["checkpoint", "summary", "briefing"].includes(action)) runTranscriptAction(action as TranscriptMode);
    else throw new Error("Unknown action.");
    publishAppState();
  });
  ipcMain.handle("app-save-settings", async (event, input: unknown) => {
    authorize(event);
    if (stealth || stealthTransition) throw new Error("Turn off stealth mode before changing settings.");
    if (busy || listeningActive()) throw new Error("Stop listening and wait for the current action before changing settings.");
    const settings = validateSettings(input);
    const previous = Object.fromEntries(shortcutKeys.map((key) => [key, process.env[key]]));
    globalShortcut.unregisterAll();
    try {
      const handlers = hotkeyHandlers();
      shortcutKeys.forEach((key, index) => {
        if (!globalShortcut.register(settings[key], handlers[index])) throw new Error(`Cannot register ${settings[key]}. Choose a different shortcut.`);
      });
      saveSettings(settings);
      stealthShortcutRegistered = true;
    } catch (err) {
      globalShortcut.unregisterAll();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      registerHotkeys();
      throw err;
    }
    setBusy(true);
    try {
      await resetAgent();
      await resetTranscription();
      startupError = "";
    } finally { setBusy(false); refreshTray(); }
    return publicSettings();
  });
  ipcMain.handle("app-context-list", (event) => { authorize(event); return listContextFiles(); });
  ipcMain.handle("app-context-text-get", (event) => { authorize(event); return getContextText(); });
  ipcMain.handle("app-context-text-save", (event, text: unknown) => { authorize(event); return saveContextText(text); });
  ipcMain.handle("app-context-add", async (event) => { authorize(event); if (stealth || stealthTransition) throw new Error("Turn off stealth mode before importing documents."); return addContextFiles(mainWindow!); });
  ipcMain.handle("app-context-remove", (event, id: string) => { authorize(event); if (typeof id !== "string") throw new Error("Invalid file."); return removeContextFile(id); });
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
  win.setContentProtection(stealth);
  win.setFocusable(!stealth);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: stealth });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(overlayPath());
  win.webContents.on("did-finish-load", () => { win.webContents.send("overlay-state", currentState); });
  win.on("closed", () => {
    overlay = null;
  });
  return win;
}

function trayTemplate(): MenuItemConstructorOptions[] {
  return [
    { label: "Open Meeting Copilot", click: openApplication },
    { label: `Enter stealth mode: ${displayHotkey(stealthHotkey())}`, enabled: stealthShortcutRegistered, click: toggleStealthMode },
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
      enabled: transcription.active,
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
  if (busy) return;
  setBusy(true);
  try {
    await transcription.stop();
    refreshTray();
    hideOverlay();
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally { setBusy(false); }
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

async function toggleLiveListening(): Promise<void> {
  if (busy) return;

  if (!transcription.active) {
    sendState("recording", `Listening… ${listeningHint()}.`);
    setBusy(true);
    try {
      await transcription.start();
      refreshTray();
    } catch (err) {
      refreshTray();
      sendState("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
    return;
  }

  await stopListening();
}

async function runLiveAction(mode: TranscriptMode): Promise<void> {
  if (busy) return;
  if (!transcription.active) {
    sendState(
      "error",
      `Start listening with ${displayHotkey(hotkey())} first.`,
    );
    return;
  }

  setBusy(true);
  try {
    sendState("transcribing", "Transcribing…");
    const transcript = await transcription.flushAndTranscript();
    await askAndShow(transcript, mode);
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally {
    setBusy(false);
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

  setBusy(true);
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
    setBusy(false);
  }
}

function runTranscriptAction(mode: TranscriptMode): void {
  if (busy) return;
  if (!checkConfiguration()) return;
  if (transcription.supportsLive) {
    void runLiveAction(mode);
    return;
  }
  void runClipAction(mode);
}

async function toggleCapture(): Promise<void> {
  if (busy) return;
  if (!listeningActive() && !checkConfiguration()) return;
  if (transcription.supportsLive) {
    await toggleLiveListening();
    return;
  }

  setBusy(true);
  try {
    if (!capture.active) {
      await capture.start();
      refreshTray();
      sendState("recording", `Recording… ${listeningHint()}.`);
    } else {
      const wavPath = await capture.stop();
      refreshTray();
      hideOverlay();
      try { fs.unlinkSync(wavPath); } catch { /* Already removed. */ }
    }
  } catch (err) {
    refreshTray();
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally { setBusy(false); }
}

async function toggleScreenshot(): Promise<void> {
  if (busy) return;

  if (!checkConfiguration(true)) return;

  hideOverlay();
  setBusy(true);
  let pngPath: string | null = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const applicationWasVisible = mainWindow?.isVisible();
    if (applicationWasVisible) mainWindow?.hide();
    try { pngPath = await captureRegion(); }
    finally { if (applicationWasVisible && !stealth && !stealthTransition) mainWindow?.show(); }
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
    setBusy(false);
  }
}

function checkConfiguration(agentOnly = false): boolean {
  try {
    const missing = agentOnly ? missingAgentKeys() : missingKeys();
    if (missing.length) throw new Error("Add your API keys in Meeting Copilot → Settings to get started.");
    return true;
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
    return false;
  }
}

function registerHotkey(accelerator: string, handler: () => void): boolean {
  const ok = globalShortcut.register(accelerator, handler);
  if (!ok) {
    sendState(
      "error",
      `Could not register hotkey ${accelerator}. Close any app using the same shortcut.`,
    );
  }
  return ok;
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
  stealthShortcutRegistered = registerHotkey(stealthHotkey(), toggleStealthMode);
  refreshTray();
}

app.setName("Meeting Copilot");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    openApplication();
  });

  app.whenReady().then(async () => {
    loadEnv();
    try { loadSettings(); } catch { startupError = "Saved settings could not be loaded. Review and save your settings again."; }
    if (process.platform === "darwin") {
      app.setActivationPolicy("regular");
      await app.dock?.show();
      app.dock?.setIcon(`${__dirname}/assets/app.png`);
    }
    overlay = createOverlay();
    registerApplicationIpc();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Meeting Copilot", submenu: [{ role: "about" }, { label: "Open Meeting Copilot", click: openApplication }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" }, { role: "windowMenu" },
    ]));
    openApplication();
    createTray();
    transcription.onUnexpectedExit = (err) => {
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
    if (!appState().configurationError) {
      try {
        await warmAgent();
      } catch (err) {
        console.error("Failed to warm the agent:", err);
      }
    }
  });

  app.on("activate", openApplication);
  app.on("window-all-closed", () => { /* The tray and listening session remain available. */ });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    capture.kill();
    void transcription.dispose();
    void disposeAgent();
  });
}
