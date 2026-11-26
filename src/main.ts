import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  systemPreferences,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { SystemAudioCapture } from "./capture";
import {
  askFromFullScreenshot,
  askWithContext,
  generateMeetingNotes,
  type ChatTurn,
  askFromScreenshot,
  disposeAgent,
  warmAgent,
  resetAgent,
} from "./agent";
import {
  loadEnv,
  missingKeys,
  missingAgentKeys,
} from "./env";
import { capturePrimaryDisplay, captureRegion } from "./screenshot";
import { transcription, transcribeWav, resetTranscription } from "./transcribe";
import { loadSettings, publicSettings, saveSettings } from "./settings";
import { validateSettings, shortcutKeys, settingDefaults, meetingLanguages, normalizeShortcut } from "./settings-config";
import { constrainOverlay } from "./overlay-layout";
import { addContextFiles, listContextFiles, removeContextFile, getContextText, saveContextText } from "./context-files";
import { assertWavHasAudio } from "./wav";
import { boundedText, MeetingHistory } from "./meeting-history";
import { MeetingModes } from "./meeting-modes";
import { missingTranscriptionKeys, readTranscriptionConfig } from "./transcription/config";
import { PermissionGate, speechPermission } from "./permissions";
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
let screenShareProtection = false;
let stealthTransition = false;
let stealthShortcutRegistered = false;
let overlaySuppressed = false;
let overlayOpacity = 1;
const capture = new SystemAudioCapture();
let history: MeetingHistory;
let modes: MeetingModes;
let permissions: PermissionGate;
let sessionStartedAt: number | null = null;
let pausedTranscript = "";
let conversation: ChatTurn[] = [];
let activeChat: AbortController | null = null;
let contextStartsAt = 0;
let useScreenContext = false;
let pendingWorkspacePage: "settings" | "history" | "modes" | null = null;

function updateTranscript(segment: string): void {
  liveTranscript = [pausedTranscript, segment.trim()].filter(Boolean).join("\n\n");
  publishAppState();
}

function beginSession(): void {
  if (sessionStartedAt !== null) return;
  sessionStartedAt = Date.now();
  latestReply = "";
  pausedTranscript = "";
  conversation = [];
  contextStartsAt = 0;
}

async function archiveSession(): Promise<void> {
  if (sessionStartedAt === null) return;
  const meeting = liveTranscript.trim() ? history.add(sessionStartedAt, liveTranscript) : null;
  sessionStartedAt = null;
  pausedTranscript = "";
  publishAppState();
  publishOverlaySession();
  if (meeting) mainWindow?.webContents.send("app-history-changed");
  if (!meeting || missingAgentKeys().length) return;
  try {
    const notes = await generateMeetingNotes(meeting.transcript);
    if (notes) history.edit(meeting.id, meeting.title, notes);
  } catch (error) {
    console.warn("Automatic meeting notes failed:", error instanceof Error ? error.name : "provider error");
  } finally {
    mainWindow?.webContents.send("app-history-changed");
  }
}

function overlayPath(): string {
  return `${__dirname}/overlay/index.html`;
}

function listeningActive(): boolean {
  return transcription.active || capture.active;
}

function overlayShortcuts(): NonNullable<OverlayState["shortcuts"]> {
  return { record: shortcutValue("HOTKEY"), answer: shortcutValue("SCREEN_ASSIST_HOTKEY"), screenshot: shortcutValue("SCREENSHOT_HOTKEY"), fullScreenshot: shortcutValue("FULL_SCREENSHOT_HOTKEY"), toggle: shortcutValue("OVERLAY_TOGGLE_HOTKEY"), stealth: shortcutValue("STEALTH_HOTKEY") };
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
  if (permissions && !permissions.snapshot().ready) { overlay?.hide(); return; }
  const wasVisible = overlay?.isVisible();
  if (!overlaySuppressed) overlay?.showInactive();
  if (!wasVisible && overlay?.isVisible()) publishOverlaySession();
  setTrayRecording(listeningActive() || status === "recording");
}

function displayHotkey(accelerator: string): string {
  return accelerator.replaceAll("Alt+", "Option+");
}

function idleTooltip(): string {
  return "Meeting Copilot";
}

function listeningHint(): string {
  const key = shortcutValue("HOTKEY");
  return key ? `Press ${displayHotkey(key)} to end the session.` : "End the session from Meeting Copilot.";
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
    live = transcription.supportsLive;
    const missing = missingKeys();
    if (missing.length) configurationError ||= "Add your API keys in Settings to get started.";
  } catch (err) { configurationError = err instanceof Error ? err.message : String(err); }
  return { permissions: permissions?.snapshot(), overlay: currentState, latestReply, transcript: liveTranscript, busy, listening: listeningActive(),
    sessionStartedAt, conversation, useScreenContext, chatActive: activeChat !== null && !activeChat.signal.aborted, displays: availableDisplays(), languages: meetingLanguages,
    live, settings: publicSettings(), configurationError, screenShareProtection: stealth || screenShareProtection, stealth, stealthAvailable: process.platform === "darwin" && stealthShortcutRegistered };
}

function setBusy(value: boolean): void {
  busy = value;
  publishAppState();
}

function publishAppState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app-state", appState());
  if (overlay?.isVisible()) publishOverlaySession();
}

function publishOverlaySession(): void {
  overlay?.webContents.send("overlay-session", {
    startedAt: sessionStartedAt, listening: listeningActive(), busy,
    mode: modes?.active().id, modes: modes?.list().modes.map(({ id, title }) => ({ id, title })),
    chatActive: activeChat !== null && !activeChat.signal.aborted, useScreenContext,
    screenShareProtection: stealth || screenShareProtection, transcript: liveTranscript,
  });
}

function openApplication(): void {
  if (stealth || stealthTransition) return;
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1120, height: 780, minWidth: 900, minHeight: 650,
      title: "Meeting Copilot", titleBarStyle: "hiddenInset", backgroundColor: "#262424",
      webPreferences: { preload: `${__dirname}/application-preload.js`, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    mainWindow.setContentProtection(screenShareProtection);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    attachLocalShortcuts(mainWindow);
    mainWindow.webContents.on("did-finish-load", publishWorkspacePage);
    void mainWindow.loadFile(`${__dirname}/application/index.html`);
    mainWindow.on("closed", () => { mainWindow = null; });
    mainWindow.on("focus", () => { void refreshPermissions(); });
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function publishWorkspacePage(): void {
  if (!pendingWorkspacePage || !mainWindow) return;
  mainWindow.webContents.send("app-open-page", pendingWorkspacePage);
  pendingWorkspacePage = null;
}

function openWorkspacePage(page: "settings" | "history" | "modes"): void {
  if (stealth || stealthTransition) return;
  const existing = mainWindow;
  pendingWorkspacePage = page;
  openApplication();
  if (existing && !existing.webContents.isLoadingMainFrame()) publishWorkspacePage();
}

function askShortcut(): void {
  if (!allowAppUse()) return;
  if (busy) return;
  if (overlay?.isVisible() && overlay.isFocused() && !stealth) {
    overlay.webContents.send("overlay-ask-shortcut");
  } else if (mainWindow?.isVisible() && mainWindow.isFocused() && !stealth) {
    mainWindow.webContents.send("app-ask-shortcut");
  } else if (useScreenContext || sessionStartedAt !== null) {
    void runChat("", useScreenContext).catch((error) => sendState("error", error.message));
  } else {
    if (!overlay?.isVisible()) toggleOverlayVisibility();
    if (!stealth) {
      overlay?.focus();
      overlay?.webContents.send("overlay-focus-composer");
    }
  }
}

function toggleScreenShareProtection(): void {
  if (!allowAppUse()) return;
  screenShareProtection = !screenShareProtection;
  mainWindow?.setContentProtection(stealth || screenShareProtection);
  overlay?.setContentProtection(stealth || screenShareProtection);
  publishAppState();
}

async function setStealthMode(enabled: boolean): Promise<void> {
  if (enabled && !allowAppUse()) return;
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
      mainWindow?.hide();
      tray?.destroy(); tray = null;
      app.setActivationPolicy("accessory");
      app.dock?.hide();
      if (!overlay) overlay = createOverlay();
      if (currentState.status === "hidden") {
        sendState("idle", `Stealth mode is on. ${displayHotkey(shortcutValue("STEALTH_HOTKEY"))} restores the app.\n${displayHotkey(shortcutValue("HOTKEY"))} starts or stops listening. Screen-share invisibility is not guaranteed.`, "Stealth");
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
      mainWindow?.setContentProtection(screenShareProtection);
      overlay?.setContentProtection(screenShareProtection);
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

const hotkeyHandlers: Record<typeof shortcutKeys[number], () => void> = {
  HOTKEY: () => { void endOrStartSession(); },
  SCREENSHOT_HOTKEY: () => { void toggleScreenshot(); },
  FULL_SCREENSHOT_HOTKEY: () => { void toggleFullScreenshot(); },
  STEALTH_HOTKEY: toggleStealthMode,
  OVERLAY_TOGGLE_HOTKEY: toggleOverlayVisibility,
  OVERLAY_LEFT_HOTKEY: () => moveOverlay(-40, 0),
  OVERLAY_RIGHT_HOTKEY: () => moveOverlay(40, 0),
  OVERLAY_UP_HOTKEY: () => moveOverlay(0, -40),
  OVERLAY_DOWN_HOTKEY: () => moveOverlay(0, 40),
  OVERLAY_SCROLL_UP_HOTKEY: () => overlay?.webContents.send("overlay-scroll", -160),
  OVERLAY_SCROLL_DOWN_HOTKEY: () => overlay?.webContents.send("overlay-scroll", 160),
  OVERLAY_OPACITY_DOWN_HOTKEY: () => changeOverlayOpacity(-0.1),
  OVERLAY_OPACITY_UP_HOTKEY: () => changeOverlayOpacity(0.1),
  OVERLAY_RESET_HOTKEY: resetOverlayLayout,
  SCREEN_ASSIST_HOTKEY: askShortcut,
  CLEAR_CHAT_HOTKEY: () => { if (!busy) clearChatContext(); },
  SETTINGS_HOTKEY: () => openWorkspacePage("settings"),
};

for (const key of shortcutKeys) {
  const handler = hotkeyHandlers[key];
  hotkeyHandlers[key] = () => {
    if ((key === "STEALTH_HOTKEY" && stealth) || allowAppUse()) handler();
  };
}

function attachLocalShortcuts(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || !(input.meta || input.control || input.alt)) return;
    // Shift changes a backslash to a pipe on common layouts.
    const key = input.code === "Backslash" ? "\\" : input.key.replace(/^Arrow/, "");
    const modifiers = [input.meta && "cmd", input.control && "ctrl", input.alt && "alt", input.shift && "shift"];
    const accelerator = normalizeShortcut([...modifiers.filter(Boolean), key].join("+"));
    const action = shortcutKeys.find((setting) => {
      const binding = shortcutValue(setting);
      return binding && normalizeShortcut(binding) === accelerator;
    });
    if (!action) return;
    event.preventDefault();
    hotkeyHandlers[action]();
  });
}

function shortcutValue(key: typeof shortcutKeys[number]): string {
  return process.env[key]?.trim() ?? settingDefaults[key];
}

function dismissOverlay(): void {
  overlaySuppressed = true;
  overlay?.hide();
}

function toggleOverlayVisibility(): void {
  if (!allowAppUse()) return;
  if (!overlay) overlay = createOverlay();
  if (overlay.isVisible()) { dismissOverlay(); return; }
  overlaySuppressed = false;
  if (currentState.status === "hidden") {
    if (latestReply) sendState("answer", latestReply);
    else sendState("idle", "", stealth ? "Stealth" : "Ready");
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
  const area = selectedDisplay().workArea;
  overlay.setBounds(constrainOverlay({ ...bounds, x: area.x + Math.round((area.width - bounds.width) / 2), y: area.y + 32 }, area));
  overlayOpacity = defaultOverlayOpacity(); publishOverlayAppearance();
}

async function refreshPermissions(): Promise<void> {
  if (!permissions) return;
  await permissions.refresh();
  if (!permissions.snapshot().ready) overlay?.hide();
  publishAppState();
}

function allowAppUse(): boolean {
  if (permissions?.snapshot().ready) return true;
  overlay?.hide();
  openApplication();
  publishAppState();
  return false;
}

function registerApplicationIpc(): void {
  function authorize(event: Electron.IpcMainInvokeEvent, allowLocked = false): void {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("Unauthorized window.");
    if (!allowLocked && !allowAppUse()) throw new Error("Complete macOS permission setup before using Meeting Copilot.");
  }
  ipcMain.handle("app-state", (event) => { authorize(event, true); return appState(); });
  ipcMain.handle("app-action", async (event, action: string) => {
    authorize(event);
    if (action === "stealth") { await setStealthMode(!stealth); return; }
    if (action === "screen-share-protection") { toggleScreenShareProtection(); return; }
    if (busy) return;
    if (action === "widget") { toggleOverlayVisibility(); return; }
    if (action === "capture") await toggleCapture();
    else if (action === "pause") await stopListening(true);
    else if (action === "end") { if (listeningActive()) await stopListening(); else await endPausedSession(); }
    else if (action === "screenshot") await toggleScreenshot();
    else if (action === "full-screenshot") await toggleFullScreenshot();
    else throw new Error("Unknown action.");
    publishAppState();
  });
  ipcMain.handle("app-save-settings", async (event, input: unknown) => {
    authorize(event);
    if (stealth || stealthTransition) throw new Error("Turn off stealth mode before changing settings.");
    if (busy || sessionStartedAt !== null || listeningActive()) throw new Error("Stop listening and wait for the current action before changing settings.");
    const settings = validateSettings(input);
    const previousLogin = process.env.AUTO_LAUNCH;
    const previousDisplay = process.env.OVERLAY_DISPLAY;
    const previous = Object.fromEntries(shortcutKeys.map((key) => [key, process.env[key]]));
    globalShortcut.unregisterAll();
    try {
      shortcutKeys.forEach((key) => {
        if (settings[key] && !globalShortcut.register(settings[key], hotkeyHandlers[key])) throw new Error(`Cannot register ${settings[key]}. Choose a different shortcut.`);
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
      if (process.platform === "darwin" && settings.AUTO_LAUNCH !== (previousLogin || "off")) app.setLoginItemSettings({ openAtLogin: settings.AUTO_LAUNCH === "on" });
      if (settings.OVERLAY_DISPLAY !== (previousDisplay || "primary")) resetOverlayLayout();
      publishOverlayAppearance();
      await resetAgent();
      await resetTranscription();
      startupError = "";
    } finally { setBusy(false); refreshTray(); }
    return publicSettings();
  });
  ipcMain.handle("app-chat", async (event, question: unknown, useScreen: unknown, smart: unknown) => {
    authorize(event);
    return runChat(boundedText(question, 4_000, "Question", useScreen === true || sessionStartedAt !== null), useScreen === true, smart === true);
  });
  ipcMain.handle("app-screen-context", (event, enabled: unknown) => { authorize(event); setScreenContext(enabled); });
  ipcMain.handle("app-chat-cancel", (event) => { authorize(event); cancelChat(); });
  ipcMain.handle("app-chat-clear", (event) => {
    authorize(event);
    clearChatContext();
  });
  ipcMain.handle("app-permissions", async (event) => {
    authorize(event, true);
    await refreshPermissions();
    return permissions.snapshot();
  });
  ipcMain.handle("app-permission-request", async (event, kind: unknown) => {
    authorize(event, true);
    try { await permissions.request(kind); }
    finally { publishAppState(); }
    return permissions.snapshot();
  });
  ipcMain.handle("app-permission-complete", async (event) => {
    authorize(event, true);
    await permissions.complete();
    publishAppState();
    return permissions.snapshot();
  });
  ipcMain.handle("app-request-microphone", async (event) => {
    authorize(event, true);
    await permissions.request("microphone");
    publishAppState();
    return permissions.snapshot().microphone === "granted";
  });
  ipcMain.handle("app-mode-list", (event) => { authorize(event); return modes.list(); });
  ipcMain.handle("app-mode-update", (event, action: string, id: unknown, title: unknown, instructions: unknown, references: unknown) => {
    authorize(event);
    if (action === "choose") modes.choose(id);
    else if (action === "save") modes.save(id, title, instructions, references);
    else if (action === "delete") modes.remove(id);
    else throw new Error("Unknown mode action.");
    publishOverlaySession();
    return modes.list();
  });
  ipcMain.handle("app-history-list", (event, query: unknown) => {
    authorize(event);
    return history.list(boundedText(query, 300, "Search", true));
  });
  ipcMain.handle("app-history-get", (event, id: unknown) => { authorize(event); return history.get(id); });
  ipcMain.handle("app-history-edit", (event, id: unknown, title: unknown, notes: unknown) => {
    authorize(event);
    if (busy) throw new Error("Wait for the current action to finish.");
    return history.edit(id, title, notes);
  });
  ipcMain.handle("app-history-delete", (event, id: unknown) => {
    authorize(event);
    if (busy) throw new Error("Wait for the current action to finish.");
    history.delete(id);
  });
  ipcMain.handle("app-history-export", async (event, id: unknown, copy: unknown) => {
    authorize(event);
    const meeting = history.get(id);
    const markdown = history.markdown(id);
    if (copy === true) {
      clipboard.writeText(markdown);
      return true;
    }
    const filename = meeting.title.replace(/[^\p{L}\p{N} ._-]/gu, " ").trim() || "Meeting";
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: `${filename}.md`, filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await fs.promises.writeFile(result.filePath, markdown, { mode: 0o600 });
    return true;
  });
  ipcMain.handle("app-history-notes", async (event, id: unknown) => {
    authorize(event);
    assertAgentReady();
    const meeting = history.get(id);
    setBusy(true);
    try {
      const notes = await generateMeetingNotes(meeting.transcript);
      if (!notes) throw new Error("The provider did not return notes.");
      return history.edit(meeting.id, meeting.title, notes);
    } finally { setBusy(false); }
  });
  ipcMain.handle("app-history-ask", async (event, id: unknown, question: unknown, query: unknown) => {
    authorize(event);
    assertAgentReady();
    const prompt = boundedText(question, 4_000, "Question");
    const selected = id === null ? history.list(boundedText(query, 300, "Search", true)).slice(0, 8).map((item) => history.get(item.id)) : [history.get(id)];
    if (!selected.length) throw new Error("No matching meetings.");
    const transcript = JSON.stringify(selected.map((meeting) => ({
      title: meeting.title, date: new Date(meeting.startedAt).toISOString(),
      transcript: meeting.transcript.slice(0, selected.length === 1 ? 75_000 : 7_000),
      notes: meeting.notes.slice(0, selected.length === 1 ? 20_000 : 2_000),
    })));
    setBusy(true);
    try { return await askWithContext({ question: prompt, transcript, archive: true }, () => {}); }
    finally { setBusy(false); }
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

function availableDisplays() {
  return (screen.getAllDisplays?.() ?? []).map((display) => ({ id: String(display.id), label: display.label || `Display ${display.id}` }));
}

function selectedDisplay() {
  const preference = process.env.OVERLAY_DISPLAY;
  if (preference === "cursor") return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return screen.getAllDisplays?.().find((display) => String(display.id) === preference) ?? screen.getPrimaryDisplay();
}

async function captureContextDisplay(): Promise<string> {
  if (!desktopCapturer || !screen.getCursorScreenPoint) return capturePrimaryDisplay();
  const display = process.env.OVERLAY_DISPLAY === "cursor" || !process.env.OVERLAY_DISPLAY
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : selectedDisplay();
  const factor = Math.min(1, 2048 / Math.max(display.size.width, display.size.height));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(display.size.width * factor), height: Math.round(display.size.height * factor) },
  });
  const image = sources.find((item) => item.display_id === String(display.id));
  if (!image || image.thumbnail.isEmpty()) throw new Error("Could not read this display. Allow Screen Recording in macOS System Settings.");
  const { writeScreenshot } = await import("./screenshot.js");
  return writeScreenshot(image.thumbnail.toPNG());
}

function createOverlay(): BrowserWindow {
  const area = selectedDisplay().workArea;
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
      sandbox: true,
    },
  });
  win.setContentProtection(stealth || screenShareProtection);
  win.setFocusable(!stealth);
  win.setIgnoreMouseEvents(stealth);
  win.setHiddenInMissionControl(stealth);
  win.setOpacity(1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: stealth });
  win.setAlwaysOnTop(true, "screen-saver");
  attachLocalShortcuts(win);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.loadFile(overlayPath());
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("overlay-state", currentState);
    publishOverlaySession();
  });
  win.on("closed", () => {
    overlay = null;
  });
  return win;
}

function trayTemplate(): MenuItemConstructorOptions[] {
  return [
    { label: "Open Meeting Copilot", click: openApplication },
    { label: `Enter stealth mode: ${displayHotkey(shortcutValue("STEALTH_HOTKEY"))}`, enabled: stealthShortcutRegistered, click: toggleStealthMode },
    { label: "Settings", click: () => openWorkspacePage("settings") },
    { label: "History", click: () => openWorkspacePage("history") },
    { type: "separator" },
    {
      label: "Stop listening",
      enabled: listeningActive(),
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

async function finishCapture(): Promise<void> {
  if (transcription.active) {
    try {
      if (typeof transcription.flushAndTranscript === "function") {
        updateTranscript(await transcription.flushAndTranscript());
      }
    } finally { await transcription.stop(); }
  } else if (capture.active) {
    const file = await capture.stop();
    try {
      assertWavHasAudio(file);
      updateTranscript(await transcribeWav(file));
    } finally { fs.rmSync(file, { force: true }); }
  }
}

async function stopListening(pause = false): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    try { await finishCapture(); }
    finally {
      pausedTranscript = liveTranscript;
      if (!pause) await archiveSession();
      refreshTray();
    }
    showStoppedRecording();
  } catch (err) {
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally { setBusy(false); }
}

async function endPausedSession(): Promise<void> {
  if (busy || sessionStartedAt === null) return;
  setBusy(true);
  try { await archiveSession(); }
  finally { setBusy(false); }
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

async function toggleLiveListening(): Promise<void> {
  if (busy) return;

  if (!transcription.active) {
    const previousTranscript = liveTranscript;
    transcriptUpdatedDuringStart = false;
    watchingTranscriptStart = true;
    liveTranscript = sessionStartedAt === null ? "" : pausedTranscript;
    publishAppState();
    sendState("recording", `Listening… ${listeningHint()}`);
    setBusy(true);
    try {
      await transcription.start();
      beginSession();
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

async function endOrStartSession(): Promise<void> {
  if (sessionStartedAt !== null && !listeningActive()) await endPausedSession();
  else await toggleCapture();
}

async function toggleCapture(): Promise<void> {
  await refreshPermissions();
  if (!allowAppUse()) return;
  if (busy) return;
  if (!listeningActive()) {
    try {
      if (missingTranscriptionKeys().length) throw new Error("Add your transcription API key in Settings.");
      if (process.platform === "darwin" && ["microphone", "both"].includes(process.env.AUDIO_SOURCE || "")) {
        const status = systemPreferences.getMediaAccessStatus("microphone");
        if (status === "denied" || status === "restricted") throw new Error("Allow microphone access in macOS System Settings → Privacy & Security.");
      }
    } catch (error) {
      sendState("error", error instanceof Error ? error.message : String(error));
      return;
    }
  }
  if (transcription.supportsLive) {
    await toggleLiveListening();
    return;
  }

  if (capture.active) { await stopListening(); return; }
  setBusy(true);
  try {
    await capture.start();
    if (sessionStartedAt === null) liveTranscript = "";
    beginSession();
    refreshTray();
    sendState("recording", `Recording… ${listeningHint()}`);
  } catch (err) {
    refreshTray();
    sendState("error", err instanceof Error ? err.message : String(err));
  } finally { setBusy(false); }
}

function assertAgentReady(): void {
  if (busy) throw new Error("Wait for the current action to finish.");
  if (missingAgentKeys().length) throw new Error("Add your AI provider key in Settings.");
}

function setScreenContext(enabled: unknown): void {
  if (typeof enabled !== "boolean") throw new Error("Invalid screen setting.");
  useScreenContext = enabled;
  publishAppState();
}

function clearChatContext(): void {
  if (busy) throw new Error("Wait for the current action to finish.");
  conversation = [];
  contextStartsAt = liveTranscript.length;
  latestReply = "";
  sendState(overlay?.isVisible() ? "idle" : "hidden", "");
  mainWindow?.webContents.send("app-new-chat");
  overlay?.webContents.send("overlay-new-chat");
}

async function withWindowsHidden<T>(callback: () => Promise<T>): Promise<T> {
  const overlayWasVisible = overlay?.isVisible();
  const applicationWasVisible = mainWindow?.isVisible();
  const applicationWasFocused = mainWindow?.isFocused();
  overlay?.hide();
  if (applicationWasVisible) mainWindow?.hide();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await callback();
  } finally {
    if (applicationWasVisible && !stealth && !stealthTransition) {
      if (applicationWasFocused) mainWindow?.show();
      else mainWindow?.showInactive();
    }
    if (overlayWasVisible && !overlaySuppressed) overlay?.showInactive();
  }
}

function cancelChat(): void {
  activeChat?.abort();
  publishAppState();
}

async function runChat(question: string, useScreen: boolean, smart = false): Promise<boolean> {
  await refreshPermissions();
  if (!allowAppUse()) throw new Error("Complete macOS permission setup before asking AI.");
  assertAgentReady();
  let image: string | undefined;
  const controller = new AbortController();
  const previousReply = latestReply;
  activeChat = controller;
  setBusy(true);
  try {
    if (useScreen) image = await withWindowsHidden(captureContextDisplay);
    controller.signal.throwIfAborted();
    if (transcription.active) updateTranscript(await transcription.flushAndTranscript());
    controller.signal.throwIfAborted();
    sendState("thinking", "Thinking…", "Ask AI");
    const activeMode = modes.active();
    const answer = await askWithContext({
      question, transcript: sessionStartedAt !== null ? liveTranscript.slice(contextStartsAt) : undefined,
      history: conversation, mode: activeMode.instructions, referenceIds: activeMode.referenceIds, screenshot: image, smart, signal: controller.signal,
    }, (full) => { if (!controller.signal.aborted) sendState("answer", full, "Ask AI"); });
    controller.signal.throwIfAborted();
    if (!answer) throw new Error("The provider did not return a response.");
    conversation = [...conversation.slice(-15), { question: question || (useScreen ? "Ask about my screen" : "Ask about this session"), answer }];
    sendState("answer", answer, "Ask AI");
    return true;
  } catch (error) {
    if (controller.signal.aborted) {
      latestReply = previousReply;
      sendState("idle", "Response stopped.", "Ask AI");
      return false;
    }
    sendState("error", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    try { if (image) fs.rmSync(image, { force: true }); }
    finally { activeChat = null; setBusy(false); }
  }
}

async function runScreenshot(
  capture: () => Promise<string | null>,
  ask: (pngPath: string, onText: (fullText: string) => void, referenceIds?: string[], modeInstructions?: string) => Promise<string>,
): Promise<void> {
  await refreshPermissions();
  if (!allowAppUse()) return;
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
    const activeMode = modes.active();
    const answer = await ask(pngPath, (full) => { sendState("answer", full); }, activeMode.referenceIds, activeMode.instructions);
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
  shortcutKeys.forEach((key) => {
    const accelerator = shortcutValue(key);
    const registered = Boolean(accelerator && registerHotkey(accelerator, hotkeyHandlers[key]));
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
    history = new MeetingHistory(path.join(app.getPath("userData"), "meetings"));
    modes = new MeetingModes(path.join(app.getPath("userData"), "meeting-modes.json"));
    try { modes.load(); } catch { startupError = "Saved meeting modes could not be loaded."; }
    try { loadSettings(); } catch { startupError = "Saved settings could not be loaded. Review and save your settings again."; }
    permissions = new PermissionGate(path.join(app.getPath("userData"), "permission-setup.json"), {
      supported: process.platform === "darwin",
      readMedia: (kind) => process.platform === "darwin" ? systemPreferences.getMediaAccessStatus(kind) : "granted",
      readSpeech: speechPermission,
      needsSpeech: () => { try { return readTranscriptionConfig().provider === "macos"; } catch { return true; } },
      requestMedia: async (kind) => {
        if (kind === "microphone") { await systemPreferences.askForMediaAccess("microphone"); }
        else {
          try { await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }); }
          catch { /* macOS may deny enumeration until access is granted. */ }
          if (systemPreferences.getMediaAccessStatus("screen") !== "granted") await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        }
      },
      openSettings: async (kind) => {
        const pane = { screen: "ScreenCapture", microphone: "Microphone", speech: "SpeechRecognition" }[kind];
        await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`);
      },
    });
    await permissions.load();
    void refreshPermissions();
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
      pausedTranscript = liveTranscript;
      refreshTray();
      sendState("error", err.message);
    };
    transcription.onTranscript = (text) => {
      if (watchingTranscriptStart) transcriptUpdatedDuringStart = true;
      updateTranscript(text);
    };
    ipcMain.on("overlay-dismiss", (event) => { if (event.sender === overlay?.webContents) dismissOverlay(); });
    ipcMain.handle("overlay-action", async (event, action: unknown, question: unknown, useScreen: unknown) => {
      if (event.sender !== overlay?.webContents || event.senderFrame !== overlay.webContents.mainFrame) throw new Error("Unauthorized window.");
      if (!allowAppUse()) throw new Error("Complete macOS permission setup before using the overlay.");
      if (stealth || stealthTransition) return;
      if (action === "dashboard") { openApplication(); return; }
      if (action === "screen-share-protection") { toggleScreenShareProtection(); return; }
      if (action === "settings" || action === "history" || action === "modes") { openWorkspacePage(action); return; }
      if (action === "mode") {
        modes.choose(question);
        mainWindow?.webContents.send("app-mode-changed", modes.list());
        publishOverlaySession();
        return;
      }
      if (action === "screen-context") { setScreenContext(useScreen); return; }
      if (action === "new-chat") { clearChatContext(); return; }
      if (action === "stop-chat") { cancelChat(); return; }
      if (action === "chat") return runChat(boundedText(question, 4_000, "Question", useScreen === true || sessionStartedAt !== null), useScreen === true);
      else if (action === "audio") { if (listeningActive()) await stopListening(true); else await toggleCapture(); }
      else if (action === "end") { if (listeningActive()) await stopListening(); else await endPausedSession(); }
      else throw new Error("Unknown overlay action.");
    });
    ipcMain.on("overlay-height", (event, height: number) => {
      if (event.sender === overlay?.webContents && typeof height === "number" && Number.isFinite(height)) {
        resizeOverlay(height);
      }
    });
    registerHotkeys();
    if (permissions.snapshot().ready && !appState().configurationError) {
      try {
        await warmAgent();
      } catch (err) {
        console.error("Failed to warm the agent:", err);
      }
    }
  });

  app.on("activate", openApplication);
  app.on("window-all-closed", () => { /* The tray and listening session remain available. */ });

  app.on("before-quit", () => {
    if (sessionStartedAt === null || !liveTranscript.trim()) return;
    try {
      history.add(sessionStartedAt, liveTranscript);
      sessionStartedAt = null;
    } catch (error) { console.error("Could not save meeting transcript on quit:", error); }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    activeChat?.abort();
    capture.kill();
    void transcription.dispose();
    void disposeAgent();
  });
}
