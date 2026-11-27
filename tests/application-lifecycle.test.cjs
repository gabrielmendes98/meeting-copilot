const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { settingDefaults, shortcutKeys } = require('../dist/settings-config');

test('Dock lifecycle and settings IPC enforce trusted senders and roll back shortcut conflicts', async (context) => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-copilot-test-'));
  context.after(() => fs.rmSync(storage, { force: true, recursive: true }));
  const windows = [], trays = [], events = {}, handlers = {}, shortcuts = new Map();
  let permissionReady = true;
  let saves = 0, resets = 0, listening = false, dockShown = false, activationPolicy, failStart = false, announceDuringStart = "";
  let tail = "", providerNotesFail = false, waitForCancellation = false;
  let signalReady;
  const requests = [];
  let regionCaptures = 0, primaryCaptures = 0, copied = "", missingAgent = [], primaryError = null, hiddenDuringPrimary = false;
  const environment = { OVERLAY_OPACITY: '60' };
  class Window {
    constructor(options) {
      this.options = options;
      this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
      this.messages = [];
      this.events = {}; this.visible = false; this.destroyed = false;
      this.webEvents = {};
      this.webContents = { mainFrame: {}, isLoadingMainFrame: () => false, send: (...message) => this.messages.push(message),
        on: (name, handler) => { this.webEvents[name] = handler; }, setWindowOpenHandler() {} };
      windows.push(this);
    }
    on(name, handler) { this.events[name] = handler; }
    loadFile() {} show() { this.visible = true; } hide() { this.visible = false; }
    showInactive() { this.visible = true; } focus() {} isFocused() { return true; } isMinimized() { return false; } isDestroyed() { return this.destroyed; }
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
    getPath: () => storage, setName() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    on: (name, handler) => { events[name] = handler; },
    setActivationPolicy: (value) => { activationPolicy = value; },
    dock: { async show() { dockShown = true; }, hide() { dockShown = false; }, setIcon() {} },
  };
  let currentSegment = "";
  const transcription = {
    get active() { return listening; }, supportsLive: true, onTranscript: null,
    async dispose() {}, async stop() { listening = false; },
    async flushAndTranscript() { return tail || currentSegment; },
    async start() {
      currentSegment = "";
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
    './permissions': {
      speechPermission: async () => 'granted',
      PermissionGate: class {
        async load() {} async refresh() {} async request() {} async complete() {}
        snapshot() { return { ready: permissionReady, granted: permissionReady, supported: true, required: ['screen', 'microphone'], screen: permissionReady ? 'granted' : 'denied', microphone: 'granted' }; }
      },
    },
    './capture': { SystemAudioCapture: class { active = false; kill() {} async start() { this.active = true; } async stop() { this.active = false; return '/tmp/copilot-test-no-audio.wav'; } } },
    './agent': {
      async generateMeetingNotes(text) {
        if (providerNotesFail) throw new Error('offline');
        return `Summary of ${text}`;
      },
      async askWithContext(input, onText) {
        requests.push(input); onText('Partial answer');
        if (waitForCancellation) await new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
          signalReady();
        });
        return 'Final answer';
      },
      async warmAgent() {}, async resetAgent() { resets++; },
      async askFromScreenshot() { return 'region answer'; },
      async askFromFullScreenshot(_png, onText) { onText('full answer'); return 'full answer'; },
    },
    './transcribe': { transcription, async resetTranscription() { resets++; }, async transcribeWav() { return 'Cloud clip'; } },
    './settings': {
      loadSettings() {}, publicSettings: () => ({ values: { ...settingDefaults, ...environment } }),
      saveSettings: (input) => { saves++; Object.assign(environment, input); },
    },
    './auto-answer': require('../dist/auto-answer'),
    './settings-config': require('../dist/settings-config'),
    './overlay-layout': require('../dist/overlay-layout'),
    './context-files': {}, './wav': { assertWavHasAudio() {} },
    './meeting-history': require('../dist/meeting-history'),
    './meeting-modes': require('../dist/meeting-modes'),
    './transcription/config': require('../dist/transcription/config'),
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
    },
  };
  const sandbox = {
    exports: {}, __dirname: path.resolve('dist'), process: { platform: 'darwin', env: environment },
    AbortController, Buffer, console, setTimeout,
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
  shortcuts.get(settingDefaults.SETTINGS_HOTKEY)();
  assert.deepEqual(main.messages.at(-1), ['app-open-page', 'settings']);
  shortcuts.get(settingDefaults.SCREEN_ASSIST_HOTKEY)();
  assert.deepEqual(main.messages.at(-1), ['app-ask-shortcut']);
  let consumed = false;
  main.webEvents['before-input-event']({ preventDefault() { consumed = true; } },
    { type: 'keyDown', code: 'Backslash', key: '\\', meta: true });
  assert.equal(consumed, true);
  assert.equal(windows[0].visible, true);
  shortcuts.get(settingDefaults.OVERLAY_TOGGLE_HOTKEY)();
  assert.equal(windows[0].visible, false);
  handlers['app-screen-context'](event, true);
  assert.equal(handlers['app-state'](event).useScreenContext, true);
  handlers['app-screen-context'](event, false);
  await assert.rejects(handlers['app-action'](event, 'checkpoint'), /Unknown action/);
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
  assert.equal(windows[0].visible, false, 'entering stealth preserves explicit overlay hiding');
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
  assert.equal(windows[0].visible, true);
  shortcuts.get(settingDefaults.OVERLAY_TOGGLE_HOTKEY)();
  assert.equal(windows[0].visible, false);
  sandbox.sendStateForTest('answer', 'Streaming reply');
  assert.equal(windows[0].visible, false, 'streaming must not reveal an explicitly hidden overlay');
  shortcuts.get(settingDefaults.OVERLAY_TOGGLE_HOTKEY)();
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].messages.findLast(([channel]) => channel === 'overlay-state')[1].text, 'Streaming reply');
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
  await handlers['app-action'](event, 'screen-share-protection');
  assert.equal(handlers['app-state'](event).screenShareProtection, true);
  assert.equal(main.visible, true);
  assert.equal(windows[0].focusable, true);
  assert.equal(main.protected, true);
  assert.equal(windows[0].protected, true);
  await handlers['app-action'](event, 'stealth');
  await handlers['app-action'](event, 'stealth');
  assert.equal(main.protected, true, 'exiting stealth keeps independently enabled protection');
  const overlayEvent = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame };
  await handlers['overlay-action'](overlayEvent, 'screen-share-protection');
  assert.equal(main.protected, false);
  assert.equal(windows[0].protected, false);
  listening = true;
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, false);
  assert.equal(windows[0].visible, true, 'stopping live recording must retain the overlay');
  assert.equal(windows[0].messages.findLast(([channel]) => channel === 'overlay-state')[1].text, 'Streaming reply');
  transcription.supportsLive = false;
  await handlers['app-action'](event, 'capture');
  await handlers['app-action'](event, 'capture');
  assert.equal(windows[0].visible, true, 'stopping a clip must retain the overlay');
  assert.equal(handlers['app-state'](event).transcript, 'Cloud clip');
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
  currentSegment = 'Kept after stop';
  transcription.onTranscript(currentSegment);
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, false);
  assert.equal(handlers['app-state'](event).transcript, 'Kept after stop');
  let matches = handlers['app-history-list'](event, 'kept after');
  assert.equal(matches.length, 1);
  const archived = handlers['app-history-get'](event, matches[0].id);
  assert.equal(archived.notes, 'Summary of Kept after stop');
  await assert.rejects(handlers['app-chat']({ sender: windows[0].webContents }, 'unauthorized'), /Unauthorized/);
  const custom = handlers['app-mode-update'](event, 'save', null, 'Custom', 'Talk about deployment.', ['release-notes']);
  assert.equal(custom.modes.find(mode => mode.id === custom.selected).instructions, 'Talk about deployment.');
  await handlers['app-chat'](event, 'What should I say?', false, false);
  await handlers['app-chat'](event, 'What about the second point?', false, true);
  assert.equal(requests.at(-1).history[0].question, 'What should I say?');
  assert.equal(requests.at(-1).mode, 'Talk about deployment.');
  assert.equal(requests.at(-1).referenceIds[0], 'release-notes');
  assert.equal(requests.at(-1).smart, true);
  waitForCancellation = true;
  const started = new Promise(resolve => { signalReady = resolve; });
  const stopped = handlers['app-chat'](event, 'Question to cancel', false, false);
  await started;
  assert.equal(handlers['app-state'](event).chatActive, true);
  handlers['app-chat-cancel'](event);
  assert.equal(await stopped, false);
  assert.equal(handlers['app-state'](event).chatActive, false);
  assert.equal(handlers['app-state'](event).conversation.length, 2);
  assert.equal(handlers['app-state'](event).latestReply, 'Final answer');
  waitForCancellation = false;
  shortcuts.get(settingDefaults.CLEAR_CHAT_HOTKEY)();
  assert.deepEqual(main.messages.at(-1), ['app-new-chat']);
  assert.equal(handlers['app-state'](event).conversation.length, 0);
  assert.equal(await handlers['app-history-ask'](event, archived.id, 'What was said?', ''), 'Final answer');
  assert.equal(requests.at(-1).archive, true);
  assert.match(requests.at(-1).transcript, /Kept after stop/);

  await handlers['app-action'](event, 'capture');
  environment.AUTO_ANSWER = 'on';
  environment.AUDIO_SOURCE = 'system';
  tail = 'Design a URL shortener. How would you scale redirects?';
  const beforeAutoAnswer = requests.length;
  transcription.onActivity();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(requests.length, beforeAutoAnswer + 1);
  assert.equal(requests.at(-1).question, tail);
  transcription.onActivity();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(requests.length, beforeAutoAnswer + 1, 'duplicate activity cannot repeat a reply');
  const designQuestion = tail;
  const visibleAnswer = handlers['app-state'](event).overlay;
  tail += '\nMm-hmm. Great. Right?';
  transcription.onActivity();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(requests.length, beforeAutoAnswer + 1);
  assert.deepEqual(handlers['app-state'](event).overlay, visibleAnswer);
  environment.AUTO_ANSWER = 'off';
  const followUp = 'What happens if that cache goes down?';
  tail += '\n' + followUp;
  await handlers['app-chat'](event, '', false, false);
  assert.equal(requests.at(-1).question, followUp);
  assert.equal(requests.at(-1).history.at(-1).question, designQuestion);
  assert.equal(handlers['app-state'](event).conversation.at(-1).question, followUp);
  tail = 'First segment, including the tail';
  await handlers['app-action'](event, 'pause');
  assert.equal(listening, false);
  assert.ok(handlers['app-state'](event).sessionStartedAt);
  await handlers['app-action'](event, 'capture');
  tail = 'Final segment';
  providerNotesFail = true;
  await handlers['app-action'](event, 'capture');
  assert.equal(handlers['app-state'](event).sessionStartedAt, null);
  matches = handlers['app-history-list'](event, 'first final');
  assert.equal(matches.length, 1);
  const recovered = handlers['app-history-get'](event, matches[0].id);
  assert.equal(recovered.transcript, 'First segment, including the tail\n\nFinal segment');
  assert.equal(recovered.notes, '');
  providerNotesFail = false;
  tail = '';
  failStart = true;
  await handlers['app-action'](event, 'capture');
  assert.equal(listening, false);
  assert.equal(handlers['app-state'](event).transcript, 'First segment, including the tail\n\nFinal segment');
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
  assert.equal(windows[0].messages.findLast(([channel]) => channel === 'overlay-state')[1].text, 'full answer');
  assert.equal(handlers['app-state'](event).conversation.at(-1).answer, 'full answer');
  await handlers['app-action'](event, 'improve-solution');
  assert.match(requests.at(-1).question, /Improve the previous programming solution/);
  assert.equal(requests.at(-1).history.at(-1).answer, 'full answer');
  assert.equal(requests.at(-1).screenshot, undefined, 'improving uses saved context without taking another screenshot');
  assert.equal(primaryCaptures, 1);
  await handlers['overlay-action'](overlayEvent, 'improve-solution');
  assert.equal(requests.at(-1).history.at(-1).answer, 'Final answer');
  const requestCount = requests.length;
  sandbox.setBusyForTest(true);
  await handlers['overlay-action'](overlayEvent, 'improve-solution');
  assert.equal(requests.length, requestCount, 'busy requests must not overwrite the active response');
  sandbox.setBusyForTest(false);
  await handlers['app-action'](event, 'stealth');
  assert.equal(handlers['app-state'](event).stealth, true);
  const capturesBeforeImprove = primaryCaptures;
  const requestsBeforeImprove = requests.length;
  shortcuts.get(settingDefaults.IMPROVE_SOLUTION_HOTKEY)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, requestsBeforeImprove + 1);
  assert.match(requests.at(-1).question, /Improve the previous programming solution/);
  assert.equal(requests.at(-1).history.at(-1).answer, 'Final answer');
  assert.equal(primaryCaptures, capturesBeforeImprove);
  assert.equal(handlers['app-state'](event).stealth, true);
  assert.equal(main.visible, false, 'improvement hotkey must not restore the workspace');
  assert.equal(windows[0].clickThrough, true);
  assert.equal(handlers['app-state'](event).overlay.shortcuts.improve, 'Alt+Shift+I');
  sandbox.setBusyForTest(true);
  shortcuts.get(settingDefaults.IMPROVE_SOLUTION_HOTKEY)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, requestsBeforeImprove + 1);
  sandbox.setBusyForTest(false);
  await handlers['app-action'](event, 'stealth');
  handlers['app-chat-clear'](event);
  await assert.rejects(handlers['app-action'](event, 'improve-solution'), /Ask for a solution first/);
  shortcuts.get(settingDefaults.IMPROVE_SOLUTION_HOTKEY)();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(handlers['app-state'](event).overlay.text, /Ask for a solution first/);


  primaryError = new Error('Could not capture the primary display. Check Screen Recording permission.');
  await handlers['app-action'](event, 'full-screenshot');
  assert.equal(main.visible, true);
  assert.match(windows[0].messages.findLast(([channel]) => channel === 'overlay-state')[1].text, /Screen Recording permission/);
  primaryError = null;
  sandbox.setBusyForTest(true);
  await handlers['app-action'](event, 'full-screenshot');
  assert.equal(primaryCaptures, 2);
  sandbox.setBusyForTest(false);
  missingAgent = ['AGENT_API_KEY'];
  await handlers['app-action'](event, 'full-screenshot');
  assert.equal(primaryCaptures, 2);
  assert.match(windows[0].messages.findLast(([channel]) => channel === 'overlay-state')[1].text, /API keys/);
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
  const lockedWindow = windows[2];
  const lockedEvent = { sender: lockedWindow.webContents, senderFrame: lockedWindow.webContents.mainFrame };
  permissionReady = false;
  assert.equal(handlers['app-state'](lockedEvent).permissions.ready, false);
  assert.throws(() => handlers['app-mode-list'](lockedEvent), /permission setup/);
  await assert.rejects(handlers['app-chat'](lockedEvent, 'Hello', false, false), /permission setup/);
  await assert.rejects(handlers['app-action'](lockedEvent, 'screenshot'), /permission setup/);
  assert.equal(windows[0].isVisible(), false, 'locked app hides the overlay');
  assert.equal(lockedWindow.isVisible(), true, 'blocked entry points return to setup');
  await assert.rejects(handlers['app-permissions']({ sender: {}, senderFrame: {} }), /Unauthorized/);
  assert.equal((await handlers['app-permissions'](lockedEvent)).ready, false);
  const blockedCaptures = regionCaptures;
  shortcuts.get(settingDefaults.SCREENSHOT_HOTKEY)();
  shortcuts.get(environment.HOTKEY || settingDefaults.HOTKEY)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(regionCaptures, blockedCaptures, 'global shortcuts cannot bypass permission setup');
  assert.equal(listening, false);
  await assert.rejects(handlers['overlay-action'](overlayEvent, 'chat', 'Hello', false), /permission setup/);


});
