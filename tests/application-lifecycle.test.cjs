const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { settingDefaults } = require('../dist/settings-config');

test('Dock lifecycle and settings IPC enforce trusted senders and roll back shortcut conflicts', async () => {
  const windows = [], trays = [], events = {}, handlers = {}, shortcuts = new Map();
  let saves = 0, resets = 0, listening = false, dockShown = false, activationPolicy;
  const environment = {};
  class Window {
    constructor(options) {
      this.options = options;
      this.events = {}; this.visible = false; this.destroyed = false;
      this.webContents = { mainFrame: {}, send() {}, on() {}, setWindowOpenHandler() {} };
      windows.push(this);
    }
    on(name, handler) { this.events[name] = handler; }
    loadFile() {} show() { this.visible = true; } hide() { this.visible = false; }
    showInactive() { this.visible = true; } focus() {} isMinimized() { return false; } isDestroyed() { return this.destroyed; }
    setVisibleOnAllWorkspaces() {} setAlwaysOnTop() {}
    setContentProtection(value) { this.protected = value; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    setFocusable(value) { this.focusable = value; }
  }
  const app = {
    setName() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    on: (name, handler) => { events[name] = handler; },
    setActivationPolicy: (value) => { activationPolicy = value; },
    dock: { async show() { dockShown = true; }, hide() { dockShown = false; }, setIcon() {} },
  };
  const transcription = { get active() { return listening; }, supportsLive: true, async dispose() {} };
  const dependencies = {
    electron: {
      app, BrowserWindow: Window, clipboard: {}, ipcMain: { handle: (name, handler) => { handlers[name] = handler; }, on() {} },
      globalShortcut: {
        unregisterAll: () => shortcuts.clear(),
        register: (key, handler) => { if (key === 'Alt+9' || shortcuts.has(key)) return false; shortcuts.set(key, handler); return true; },
      },
      Menu: { buildFromTemplate: (value) => value, setApplicationMenu() {} },
      nativeImage: { createFromBuffer: () => ({ setTemplateImage() {} }), createEmpty() {} },
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
      Tray: class { constructor() { trays.push(this); } setToolTip() {} setContextMenu() {} setTitle() {} destroy() { this.destroyed = true; } },
    },
    './capture': { SystemAudioCapture: class { active = false; kill() {} } },
    './agent': { async warmAgent() {}, async resetAgent() { resets++; } },
    './transcribe': { transcription, pickProvider: () => 'macos', async resetTranscription() { resets++; } },
    './settings': {
      loadSettings() {}, publicSettings: () => ({ values: { ...settingDefaults, ...environment } }),
      saveSettings: (input) => { saves++; Object.assign(environment, input); },
    },
    './settings-config': require('../dist/settings-config'),
    './context-files': {}, './screenshot': {}, './wav': {},
    './env': {
      loadEnv() {}, missingKeys: () => [], missingAgentKeys: () => [],
      hotkey: () => environment.HOTKEY || settingDefaults.HOTKEY,
      checkpointHotkey: () => environment.CHECKPOINT_HOTKEY || settingDefaults.CHECKPOINT_HOTKEY,
      summaryHotkey: () => environment.SUMMARY_HOTKEY || settingDefaults.SUMMARY_HOTKEY,
      briefingHotkey: () => environment.BRIEFING_HOTKEY || settingDefaults.BRIEFING_HOTKEY,
      screenshotHotkey: () => environment.SCREENSHOT_HOTKEY || settingDefaults.SCREENSHOT_HOTKEY,
      stealthHotkey: () => environment.STEALTH_HOTKEY || settingDefaults.STEALTH_HOTKEY,
    },
  };
  const sandbox = {
    exports: {}, __dirname: path.resolve('dist'), process: { platform: 'darwin', env: environment },
    Buffer, console, setTimeout,
    require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.resolve('dist/main.js'), 'utf8') + '\nglobalThis.setBusyForTest = setBusy; globalThis.registerHotkeysForTest = registerHotkeys;', sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dockShown, true);
  assert.equal(activationPolicy, 'regular');
  assert.equal(windows.length, 2);
  const main = windows[1];
  assert.equal(main.visible, true);
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  await assert.rejects(handlers['app-save-settings']({ sender: windows[0].webContents }, settingDefaults), /Unauthorized/);
  listening = true;
  await assert.rejects(handlers['app-save-settings'](event, settingDefaults), /Stop listening/);
  listening = false;
  await assert.rejects(handlers['app-save-settings'](event, { ...settingDefaults, HOTKEY: 'Alt+9' }), /Cannot register/);
  assert.equal(saves, 0);
  assert.deepEqual([...shortcuts.keys()], ['Alt+Space', 'Alt+1', 'Alt+2', 'Alt+3', 'Alt+Shift+Space', 'Alt+Shift+S']);
  await handlers['app-save-settings'](event, { ...settingDefaults, HOTKEY: 'Alt+8' });
  assert.equal(saves, 1);
  assert.equal(resets, 2);
  assert.equal(shortcuts.has('Alt+8'), true);
  // The restore shortcut must remain available even while an agent is busy.
  sandbox.setBusyForTest(true);
  await assert.rejects(handlers['app-action']({ sender: windows[0].webContents }, 'stealth'), /Unauthorized/);
  await handlers['app-action'](event, 'stealth');
  assert.equal(handlers['app-state'](event).stealth, true);
  assert.equal(handlers['app-state'](event).busy, true);
  assert.equal(handlers['app-state'](event).latestReply, '');
  assert.equal(main.visible, false);
  assert.equal(main.skipTaskbar, true);
  assert.equal(main.protected, true);
  assert.equal(windows[0].protected, true);
  assert.equal(windows[0].focusable, false);
  assert.equal(windows[0].visible, true);
  assert.equal(trays[0].destroyed, true);
  assert.equal(dockShown, false);
  assert.equal(activationPolicy, 'accessory');
  events.activate(); events['second-instance']();
  assert.equal(main.visible, false, 'activation must not expose the workspace during stealth');
  await assert.rejects(handlers['app-save-settings'](event, settingDefaults), /Turn off stealth/);
  await assert.rejects(handlers['app-context-add'](event), /Turn off stealth/);
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
  assert.equal(trays.length, 2);
  sandbox.setBusyForTest(false);
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
  main.destroyed = true; main.events.closed();
  events.activate();
  assert.equal(windows.length, 3);
  assert.equal(windows[2].visible, true);
  events['second-instance']();
  assert.equal(windows.length, 3, 'reopening should reuse the existing workspace');
});
