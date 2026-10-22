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
  askFromFullScreenshot,
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
  fullScreenshotHotkey,
  screenshotHotkey,
  summaryHotkey,
  stealthHotkey,
} from "./env";
import { capturePrimaryDisplay, captureRegion } from "./screenshot";
import { transcription, transcribeWav, resetTranscription, pickProvider } from "./transcribe";
import { loadSettings, publicSettings, saveSettings } from "./settings";
import { validateSettings, shortcutKeys, settingDefaults } from "./settings-config";
import { constrainOverlay } from "./overlay-layout";
import { addContextFiles, listContextFiles, removeContextFile, getContextText, saveContextText } from "./context-files";
import { assertWavHasAudio } from "./wav";
import type { OverlayState, OverlayStatus } from "./types";

let overlay: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let currentState: OverlayState = { status: "hidden", text: "" };
let latestReply = "";
let liveTranscript = "";
let watchingTranscriptStart = false;
let transcriptUpdatedDuringStart = false;
let startupError = "";
let tray: Tray | null = null;
let busy = false;
let stealth = false;
let stealthTransition = false;
let stealthShortcutRegistered = false;
let overlaySuppressed = false;
let overlayOpacity = 1;
const capture = new SystemAudioCapture();

function overlayPath(): string {
  return `${__dirname}/overlay/index.html`;
}

function listeningActive(): boolean {
  return transcription.active || capture.active;
}

function overlayShortcuts(): NonNullable<OverlayState["shortcuts"]> {
  return { record: hotkey(), answer: checkpointHotkey(), summary: summaryHotkey(), notes: briefingHotkey(), screenshot: screenshotHotkey(), fullScreenshot: fullScreenshotHotkey(), toggle: shortcutValue("OVERLAY_TOGGLE_HOTKEY"), stealth: stealthHotkey() };
}

function sendState(status: OverlayStatus, text = "", label?: string): void {
  const state: OverlayState = { status, text, label, stealth, opacity: overlayOpacity, shortcuts: overlayShortcuts() };
  currentState = state;
  if (status === "answer") latestReply = text;
  publishAppState();
  overlay?.webContents.send("overlay-state", state);
  if (status === "hidden") {
    overlay?.hide();
    setTrayRecording(listeningActive());
    return;
  }
  if (!overlaySuppressed) overlay?.showInactive();
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
  return { overlay: currentState, latestReply, transcript: liveTranscript, busy, listening: listeningActive(),
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
      overlay?.setIgnoreMouseEvents(true);
      overlay?.setHiddenInMissionControl(true);
      mainWindow?.setHiddenInMissionControl(true);
      mainWindow?.setSkipTaskbar(true);
      stealth = true;
      overlaySuppressed = false;
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
      overlay?.setIgnoreMouseEvents(false);
      overlay?.setHiddenInMissionControl(false);
      mainWindow?.setHiddenInMissionControl(false);
      mainWindow?.setSkipTaskbar(false);
      stealth = false;
      if (!tray) createTray();
      refreshTray();
      sendState(currentState.status, currentState.text, currentState.label);
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
  return [() => { void toggleCapture(); }, () => runTranscriptAction("checkpoint"), () => runTranscriptAction("summary"), () => runTranscriptAction("briefing"), () => { void toggleScreenshot(); }, () => { void toggleFullScreenshot(); }, toggleStealthMode,
    toggleOverlayVisibility, () => moveOverlay(-40, 0), () => moveOverlay(40, 0), () => moveOverlay(0, -40), () => moveOverlay(0, 40),
    () => overlay?.webContents.send("overlay-scroll", -160), () => overlay?.webContents.send("overlay-scroll", 160),
    () => changeOverlayOpacity(-0.1), () => changeOverlayOpacity(0.1), resetOverlayLayout];
}

function shortcutValue(key: typeof shortcutKeys[number]): string {
  return process.env[key]?.trim() || settingDefaults[key];
}

function dismissOverlay(): void {
  overlaySuppressed = true;
  overlay?.hide();
}

function toggleOverlayVisibility(): void {
  if (!overlay) overlay = createOverlay();
  if (overlay.isVisible()) { dismissOverlay(); return; }
  overlaySuppressed = false;
  if (currentState.status === "hidden") {
    if (latestReply) sendState("answer", latestReply);
    else sendState("idle", `${displayHotkey(hotkey())} starts or stops listening. ${displayHotkey(checkpointHotkey())} asks for an answer.`, stealth ? "Stealth" : "Ready");
  } else { sendState(currentState.status, currentState.text, currentState.label); }
}

function moveOverlay(dx: number, dy: number): void {
  if (!overlay) return;
  const bounds = overlay.getBounds();
  const next = { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
  overlay.setBounds(constrainOverlay(next, screen.getDisplayMatching(next).workArea));
}

function changeOverlayOpacity(delta: number): void {
  overlayOpacity = Math.min(1, Math.max(0.3, Math.round((overlayOpacity + delta) * 100) / 100));
  publishOverlayAppearance();
}

function publishOverlayAppearance(): void {
  // Keep native opacity at 100%; the renderer independently composites text and background.
  currentState = { ...currentState, opacity: overlayOpacity, shortcuts: overlayShortcuts() };
  overlay?.webContents.send("overlay-state", currentState);
}

function defaultOverlayOpacity(): number {
  const percent = Number(publicSettings().values.OVERLAY_OPACITY);
  return Number.isInteger(percent) && percent >= 30 && percent <= 100 ? percent / 100 : 1;
}

function resetOverlayLayout(): void {
  if (!overlay) return;
  const bounds = overlay.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  overlay.setBounds(constrainOverlay({ ...bounds, x: area.x + Math.round((area.width - bounds.width) / 2), y: area.y + 32 }, area));
  overlayOpacity = defaultOverlayOpacity(); publishOverlayAppearance();
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
    else if (action === "full-screenshot") await toggleFullScreenshot();
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
      overlayOpacity = defaultOverlayOpacity();
      publishOverlayAppearance();
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
  const area = overlay ? screen.getDisplayMatching(overlay.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  return Math.round(area.height * 0.55);
}

function resizeOverlay(contentHeight: number): void {
  if (!overlay) return;
  const height = Math.min(
    overlayMaxHeight(),
    Math.max(OVERLAY_MIN_HEIGHT, Math.ceil(contentHeight)),
  );
  const bounds = overlay.getBounds();
  overlay.setBounds(constrainOverlay({ ...bounds, height }, screen.getDisplayMatching(bounds).workArea));
}

function createOverlay(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = constrainOverlay({ width: OVERLAY_WIDTH, height: OVERLAY_MIN_HEIGHT, x: area.x + Math.round((area.width - OVERLAY_WIDTH) / 2), y: area.y + 32 }, area);
  const win = new BrowserWindow({
    ...bounds,
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
  win.setIgnoreMouseEvents(stealth);
  win.setHiddenInMissionControl(stealth);
  win.setOpacity(1);
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
    {
      label: `Full screenshot: ${displayHotkey(fullScreenshotHotkey())}`,
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

async function stopListening(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    await transcription.stop();
    refreshTray();
    showStoppedRecording();
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally { setBusy(false); }
}

function showStoppedRecording(): void {
  if (currentState.status === "answer" || currentState.status === "error") {
    sendState(currentState.status, currentState.text, currentState.label);
  } else if (latestReply) {
    sendState("answer", latestReply);
  } else {
    sendState("idle", "Recording stopped. Your copilot is ready when you are.");
  }
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
    const previousTranscript = liveTranscript;
    transcriptUpdatedDuringStart = false;
    watchingTranscriptStart = true;
    liveTranscript = "";
    publishAppState();
    sendState("recording", `Listening… ${listeningHint()}.`);
    setBusy(true);
    try {
      await transcription.start();
      refreshTray();
    } catch (err) {
      if (!transcriptUpdatedDuringStart) liveTranscript = previousTranscript;
      refreshTray();
      sendState("error", err instanceof Error ? err.message : String(err));
    } finally {
      watchingTranscriptStart = false;
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
      showStoppedRecording();
      try { fs.unlinkSync(wavPath); } catch { /* Already removed. */ }
    }
  } catch (err) {
    refreshTray();
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally { setBusy(false); }
}

async function runScreenshot(
  capture: () => Promise<string | null>,
  ask: (pngPath: string, onText: (fullText: string) => void) => Promise<string>,
): Promise<void> {
  if (busy) return;
  if (!checkConfiguration(true)) return;

  const overlayWasVisible = overlay?.isVisible();
  overlay?.hide();
  setBusy(true);
  let pngPath: string | null = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const applicationWasVisible = mainWindow?.isVisible();
    if (applicationWasVisible) mainWindow?.hide();
    try { pngPath = await capture(); }
    finally { if (applicationWasVisible && !stealth && !stealthTransition) mainWindow?.show(); }
    if (!pngPath) {
      if (overlayWasVisible && !overlaySuppressed) overlay?.showInactive();
      return;
    }
    sendState("thinking", "Reading the screenshot…");
    const answer = await ask(pngPath, (full) => { sendState("answer", full); });
    const text = answer || "The request wasn't clear.";
    sendState("answer", text);
    clipboard.writeText(text);
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally {
    if (pngPath) {
      try { fs.unlinkSync(pngPath); } catch { /* Already removed. */ }
    }
    setBusy(false);
  }
}

function toggleScreenshot(): Promise<void> {
  return runScreenshot(captureRegion, askFromScreenshot);
}

function toggleFullScreenshot(): Promise<void> {
  return runScreenshot(capturePrimaryDisplay, askFromFullScreenshot);
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
  const handlers = hotkeyHandlers();
  shortcutKeys.forEach((key, index) => {
    const registered = registerHotkey(shortcutValue(key), handlers[index]);
    if (key === "STEALTH_HOTKEY") stealthShortcutRegistered = registered;
  });
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
    overlayOpacity = defaultOverlayOpacity();
    currentState = { ...currentState, opacity: overlayOpacity, shortcuts: overlayShortcuts() };
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
    transcription.onTranscript = (text) => {
      if (watchingTranscriptStart) transcriptUpdatedDuringStart = true;
      liveTranscript = text;
      publishAppState();
    };
    ipcMain.on("overlay-dismiss", (event) => { if (event.sender === overlay?.webContents) dismissOverlay(); });
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
