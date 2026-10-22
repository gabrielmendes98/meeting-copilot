const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { settingDefaults, shortcutKeys } = require('../dist/settings-config');

test('Dock lifecycle and settings IPC enforce trusted senders and roll back shortcut conflicts', async () => {
  const windows = [], trays = [], events = {}, handlers = {}, shortcuts = new Map();
  let saves = 0, resets = 0, listening = false, dockShown = false, activationPolicy, failStart = false, announceDuringStart = "";
  let regionCaptures = 0, primaryCaptures = 0, copied = "", missingAgent = [], primaryError = null, hiddenDuringPrimary = false;
  const environment = { OVERLAY_OPACITY: '60' };
  class Window {
    constructor(options) {
      this.options = options;
      this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
      this.messages = [];
      this.events = {}; this.visible = false; this.destroyed = false;
      this.webContents = { mainFrame: {}, send: (...message) => this.messages.push(message), on() {}, setWindowOpenHandler() {} };
      windows.push(this);
    }
    on(name, handler) { this.events[name] = handler; }
    loadFile() {} show() { this.visible = true; } hide() { this.visible = false; }
    showInactive() { this.visible = true; } focus() {} isMinimized() { return false; } isDestroyed() { return this.destroyed; }
    setVisibleOnAllWorkspaces() {} setAlwaysOnTop() {}
    setContentProtection(value) { this.protected = value; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    setFocusable(value) { this.focusable = value; }
    setIgnoreMouseEvents(value) { this.clickThrough = value; }
    setHiddenInMissionControl(value) { this.hiddenInMissionControl = value; }
    setOpacity(value) { this.opacity = value; }
    isVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = value; }
  }
  const app = {
    setName() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    on: (name, handler) => { events[name] = handler; },
    setActivationPolicy: (value) => { activationPolicy = value; },
    dock: { async show() { dockShown = true; }, hide() { dockShown = false; }, setIcon() {} },
  };
  const transcription = {
    get active() { return listening; }, supportsLive: true, onTranscript: null,
    async dispose() {}, async stop() { listening = false; },
    async start() {
      if (announceDuringStart && this.onTranscript) this.onTranscript(announceDuringStart);
      if (failStart) throw new Error('could not listen');
      listening = true;
    },
  };
  const dependencies = {
    electron: {
      app, BrowserWindow: Window, clipboard: { writeText(value) { copied = value; } }, ipcMain: { handle: (name, handler) => { handlers[name] = handler; }, on() {} },
      globalShortcut: {
        unregisterAll: () => shortcuts.clear(),
        register: (key, handler) => { if (key === 'Alt+9' || shortcuts.has(key)) return false; shortcuts.set(key, handler); return true; },
      },
      Menu: { buildFromTemplate: (value) => value, setApplicationMenu() {} },
      nativeImage: { createFromBuffer: () => ({ setTemplateImage() {} }), createEmpty() {} },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
      Tray: class { constructor() { trays.push(this); } setToolTip() {} setContextMenu() {} setTitle() {} destroy() { this.destroyed = true; } },
    },
    './capture': { SystemAudioCapture: class { active = false; kill() {} async start() { this.active = true; } async stop() { this.active = false; return '/tmp/copilot-test-no-audio.wav'; } } },
    './agent': {
      async warmAgent() {}, async resetAgent() { resets++; },
      async askFromScreenshot() { return 'region answer'; },
      async askFromFullScreenshot(_png, onText) { onText('full answer'); return 'full answer'; },
    },
    './transcribe': { transcription, pickProvider: () => 'macos', async resetTranscription() { resets++; } },
    './settings': {
      loadSettings() {}, publicSettings: () => ({ values: { ...settingDefaults, ...environment } }),
      saveSettings: (input) => { saves++; Object.assign(environment, input); },
    },
    './settings-config': require('../dist/settings-config'),
    './overlay-layout': require('../dist/overlay-layout'),
    './context-files': {}, './wav': {},
    './screenshot': {
      async captureRegion() { regionCaptures++; return '/tmp/region.png'; },
      async capturePrimaryDisplay() {
        primaryCaptures++;
        hiddenDuringPrimary = !windows[0].isVisible() && !windows[1].isVisible();
        if (primaryError) throw primaryError;
        return '/tmp/primary.png';
      },
    },
    './env': {
      loadEnv() {}, missingKeys: () => [], missingAgentKeys: () => missingAgent,
      hotkey: () => environment.HOTKEY || settingDefaults.HOTKEY,
      checkpointHotkey: () => environment.CHECKPOINT_HOTKEY || settingDefaults.CHECKPOINT_HOTKEY,
      summaryHotkey: () => environment.SUMMARY_HOTKEY || settingDefaults.SUMMARY_HOTKEY,
      briefingHotkey: () => environment.BRIEFING_HOTKEY || settingDefaults.BRIEFING_HOTKEY,
      screenshotHotkey: () => environment.SCREENSHOT_HOTKEY || settingDefaults.SCREENSHOT_HOTKEY,
      fullScreenshotHotkey: () => environment.FULL_SCREENSHOT_HOTKEY || settingDefaults.FULL_SCREENSHOT_HOTKEY,
      stealthHotkey: () => environment.STEALTH_HOTKEY || settingDefaults.STEALTH_HOTKEY,
    },
  };
  const sandbox = {
    exports: {}, __dirname: path.resolve('dist'), process: { platform: 'darwin', env: environment },
    Buffer, console, setTimeout,
    require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.resolve('dist/main.js'), 'utf8') + '\nglobalThis.setBusyForTest = setBusy; globalThis.registerHotkeysForTest = registerHotkeys; globalThis.sendStateForTest = sendState; globalThis.resizeOverlayForTest = resizeOverlay; globalThis.opacityForTest = () => overlayOpacity;', sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dockShown, true);
  assert.equal(activationPolicy, 'regular');
  assert.equal(windows.length, 2);
  assert.equal(sandbox.opacityForTest(), 0.6, 'startup uses the saved default opacity');
  assert.equal(windows[0].opacity, 1, 'native window opacity must not attenuate the text');
  const main = windows[1];
  assert.equal(main.visible, true);
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  await assert.rejects(handlers['app-save-settings']({ sender: windows[0].webContents }, settingDefaults), /Unauthorized/);
  listening = true;
  await assert.rejects(handlers['app-save-settings'](event, settingDefaults), /Stop listening/);
  listening = false;
  await assert.rejects(handlers['app-save-settings'](event, { ...settingDefaults, HOTKEY: 'Alt+9' }), /Cannot register/);
  assert.equal(saves, 0);
  assert.deepEqual([...shortcuts.keys()], shortcutKeys.map(key => settingDefaults[key]));
  await handlers['app-save-settings'](event, { ...settingDefaults, HOTKEY: 'Alt+8', OVERLAY_OPACITY: '70' });
  assert.equal(saves, 1);
  assert.equal(resets, 2);
  assert.equal(shortcuts.has('Alt+8'), true);
  assert.equal(windows[0].messages.at(-1)[1].opacity, 0.7, 'saving a default applies it immediately');
  // The restore shortcut must remain available even while an agent is busy.
  sandbox.setBusyForTest(true);
  await assert.rejects(handlers['app-action']({ sender: windows[0].webContents }, 'stealth'), /Unauthorized/);
  await handlers['app-action'](event, 'stealth');
  assert.equal(handlers['app-state'](event).stealth, true);
  assert.equal(handlers['app-state'](event).busy, true);
  assert.equal(handlers['app-state'](event).latestReply, '');
  assert.equal(handlers['app-state'](event).transcript, '');
  assert.equal(main.visible, false);
  assert.equal(main.skipTaskbar, true);
  assert.equal(main.protected, true);
  assert.equal(windows[0].protected, true);
  assert.equal(windows[0].focusable, false);
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].clickThrough, true);
  assert.equal(windows[0].hiddenInMissionControl, true);
  assert.equal(main.hiddenInMissionControl, true);
  assert.equal(trays[0].destroyed, true);
  assert.equal(dockShown, false);
  assert.equal(activationPolicy, 'accessory');
  events.activate(); events['second-instance']();
  assert.equal(main.visible, false, 'activation must not expose the workspace during stealth');
  await assert.rejects(handlers['app-save-settings'](event, settingDefaults), /Turn off stealth/);
  await assert.rejects(handlers['app-context-add'](event), /Turn off stealth/);
  shortcuts.get(settingDefaults.OVERLAY_TOGGLE_HOTKEY)();
  assert.equal(windows[0].visible, false);
  sandbox.sendStateForTest('answer', 'Streaming reply');
  assert.equal(windows[0].visible, false, 'streaming must not reveal an explicitly hidden overlay');
  shortcuts.get(settingDefaults.OVERLAY_TOGGLE_HOTKEY)();
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].messages.at(-1)[1].text, 'Streaming reply');
  const startX = windows[0].bounds.x;
  shortcuts.get(settingDefaults.OVERLAY_RIGHT_HOTKEY)();
  assert.equal(windows[0].bounds.x, startX + 40);
  sandbox.resizeOverlayForTest(300);
  assert.equal(windows[0].bounds.x, startX + 40, 'streaming resize must preserve user placement');
  for (let i = 0; i < 100; i++) shortcuts.get(settingDefaults.OVERLAY_LEFT_HOTKEY)();
  assert.equal(windows[0].bounds.x, 0);
  shortcuts.get(settingDefaults.OVERLAY_SCROLL_DOWN_HOTKEY)();
  assert.deepEqual(windows[0].messages.at(-1), ['overlay-scroll', 160]);
  for (let i = 0; i < 20; i++) shortcuts.get(settingDefaults.OVERLAY_OPACITY_DOWN_HOTKEY)();
  assert.equal(windows[0].messages.at(-1)[1].opacity, 0.3);
  shortcuts.get(settingDefaults.OVERLAY_RESET_HOTKEY)();
  assert.equal(windows[0].messages.at(-1)[1].opacity, 0.7, 'reset restores the saved default after temporary keyboard adjustments');
  assert.equal(windows[0].bounds.x, startX);
  shortcuts.get('Alt+Shift+S')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handlers['app-state'](event).stealth, false);
  assert.equal(handlers['app-state'](event).busy, true);
  assert.equal(dockShown, true);
  assert.equal(activationPolicy, 'regular');
  assert.equal(main.visible, true);
  assert.equal(main.protected, false);
  assert.equal(main.skipTaskbar, false);
  assert.equal(windows[0].protected, false);
  assert.equal(windows[0].focusable, true);
  assert.equal(windows[0].clickThrough, false);
  assert.equal(windows[0].hiddenInMissionControl, false);
  assert.equal(main.hiddenInMissionControl, false);
  assert.equal(trays.length, 2);
  sandbox.setBusyForTest(false);
  listening = true;
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, false);
  assert.equal(windows[0].visible, true, 'stopping live recording must retain the overlay');
  assert.equal(windows[0].messages.at(-1)[1].text, 'Streaming reply');
  transcription.supportsLive = false;
  await handlers['app-action'](event, 'capture');
  await handlers['app-action'](event, 'capture');
  assert.equal(windows[0].visible, true, 'stopping a clip must retain the overlay');
  assert.equal(windows[0].messages.at(-1)[1].text, 'Streaming reply');
  transcription.supportsLive = true;
  // A conflicting replacement restores every old shortcut, including the exit shortcut.
  await assert.rejects(handlers['app-save-settings'](event, { ...settingDefaults, STEALTH_HOTKEY: 'Alt+9' }), /Cannot register/);
  assert.equal(shortcuts.has('Alt+Shift+S'), true);
  assert.equal(handlers['app-state'](event).stealthAvailable, true);
  shortcuts.clear(); environment.STEALTH_HOTKEY = 'Alt+9';
  sandbox.registerHotkeysForTest();
  assert.equal(handlers['app-state'](event).stealthAvailable, false);
  await assert.rejects(handlers['app-action'](event, 'stealth'), /available stealth shortcut/);
  assert.equal(main.visible, true);
  assert.equal(dockShown, true);
  delete environment.STEALTH_HOTKEY; shortcuts.clear(); sandbox.registerHotkeysForTest();
  transcription.onTranscript('Hello there');
  assert.equal(handlers['app-state'](event).transcript, 'Hello there');
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, true);
  assert.equal(handlers['app-state'](event).transcript, '');
  transcription.onTranscript('Kept after stop');
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, false);
  assert.equal(handlers['app-state'](event).transcript, 'Kept after stop');
  failStart = true;
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, false);
  assert.equal(handlers['app-state'](event).transcript, 'Kept after stop');
  announceDuringStart = '';
  await handlers['app-action'](event, 'screenshot');
  assert.equal(regionCaptures, 1);
  assert.equal(primaryCaptures, 0);
  assert.equal(copied, 'region answer');
  assert.equal(main.visible, true);
  await handlers['app-action'](event, 'full-screenshot');
  assert.equal(primaryCaptures, 1);
  assert.equal(hiddenDuringPrimary, true);
  assert.equal(main.visible, true);
  assert.equal(windows[0].visible, true);
  assert.equal(copied, 'full answer');
  assert.equal(windows[0].messages.at(-1)[1].text, 'full answer');
  primaryError = new Error('Could not capture the primary display. Check Screen Recording permission.');
  await handlers['app-action'](event, 'full-screenshot');
  assert.equal(main.visible, true);
  assert.match(windows[0].messages.at(-1)[1].text, /Screen Recording permission/);
  primaryError = null;
  sandbox.setBusyForTest(true);
  await handlers['app-action'](event, 'full-screenshot');
  assert.equal(primaryCaptures, 2);
  sandbox.setBusyForTest(false);
  missingAgent = ['AGENT_API_KEY'];
  await handlers['app-action'](event, 'full-screenshot');
  assert.equal(primaryCaptures, 2);
  assert.match(windows[0].messages.at(-1)[1].text, /API keys/);
  missingAgent = [];
  announceDuringStart = 'Partial';
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, false);
  assert.equal(handlers['app-state'](event).transcript, 'Partial');
  main.destroyed = true; main.events.closed();
  events.activate();
  assert.equal(windows.length, 3);
  assert.equal(windows[2].visible, true);
  events['second-instance']();
  assert.equal(windows.length, 3, 'reopening should reuse the existing workspace');
});
