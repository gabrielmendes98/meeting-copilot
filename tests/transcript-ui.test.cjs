const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const emptyCopy = 'Start listening from Meeting. Recognized speech will appear here and stay until the next meeting starts.';
const unavailableCopy = 'Live transcription needs the macOS speech provider. Choose it in Settings.';

function loadApp() {
  const elements = new Map();
  let copied = '';
  let copyError = false;
  let handler;
  function element() {
    const el = {
      value: '', textContent: '', hidden: false, disabled: false,
      scrollTop: 0, scrollHeight: 0, clientHeight: 0, firstChild: { textContent: '' },
      classes: {}, children: [], listeners: {},
      classList: { toggle(name, on) { el.classes[name] = on; }, add() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      append() {}, replaceChildren() {}, setAttribute() {}, removeAttribute() {},
    };
    return el;
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('settings-form').elements = {
    STT_PROVIDER: element(), AGENT_PROVIDER: element(), AGENT_MODEL: element(),
    AGENT_API_KEY: element(), STT_PROVIDER_API_KEY: element(),
  };
  const api = {
    onState(fn) { handler = fn; },
    async getState() { throw new Error('transcript-only fixture'); },
    async listContext() { return []; },
    async getContextText() { return ''; },
  };
  vm.runInNewContext(fs.readFileSync('src/application/app.js', 'utf8'), {
    window: { meetingCopilot: api },
    document: {
      body: { classList: { toggle() {} } },
      getElementById: get, querySelectorAll: () => [], createElement: element, querySelector() { return { scrollTop: 0 }; },
    },
    navigator: { clipboard: { async writeText(value) { if (copyError) throw new Error('denied'); copied = value; } } },
    setTimeout() {}, clearTimeout() {},
  });
  const shortcuts = { HOTKEY: 'Alt+Space', CHECKPOINT_HOTKEY: 'Alt+1', SUMMARY_HOTKEY: 'Alt+2', BRIEFING_HOTKEY: 'Alt+3', SCREENSHOT_HOTKEY: 'Alt+Shift+Space', STEALTH_HOTKEY: 'Alt+Shift+S' };
  return {
    get, handler, notice: () => get('notice').textContent,
    copied: () => copied,
    failCopy() { copyError = true; },
    show(overrides = {}) {
      handler({
        listening: false, busy: false, live: true, stealthAvailable: true, configurationError: '',
        latestReply: '', transcript: '', overlay: { status: 'idle', text: '' },
        settings: { values: shortcuts }, ...overrides,
      });
    },
  };
}

test('transcript page sits between Meeting and Context library', () => {
  const html = fs.readFileSync('src/application/index.html', 'utf8');
  const meeting = html.indexOf('data-page="meeting"');
  const transcript = html.indexOf('data-page="transcript"');
  const context = html.indexOf('data-page="context"');
  assert.ok(meeting >= 0 && transcript > meeting && context > transcript);
  assert.match(html, /id="page-transcript"/);
  assert.match(html, /Copy transcript/);
  assert.match(html, /What macOS has heard in this meeting\./);
});

test('transcript screen shows macOS text, the empty hint, or the cloud message', async () => {
  const ui = loadApp();
  await new Promise(resolve => setImmediate(resolve));
  ui.show({ live: false, transcript: 'Hidden while cloud is selected' });
  assert.equal(ui.get('transcript').textContent, unavailableCopy);
  assert.equal(ui.get('transcript').classes.empty, true);
  assert.equal(ui.get('copy-transcript').disabled, true);

  ui.show({ live: true, transcript: '   ' });
  assert.equal(ui.get('transcript').textContent, emptyCopy);
  assert.equal(ui.get('copy-transcript').disabled, true);

  ui.show({ live: true, transcript: ' Hello team ' });
  assert.equal(ui.get('transcript').textContent, 'Hello team');
  assert.equal(ui.get('transcript').classes.empty, false);
  assert.equal(ui.get('copy-transcript').disabled, false);
  await ui.get('copy-transcript').listeners.click();
  assert.equal(ui.copied(), ' Hello team ');
  assert.equal(ui.notice(), 'Transcript copied.');
});

test('transcript follows the bottom only when the reader is already there', async () => {
  const ui = loadApp();
  await new Promise(resolve => setImmediate(resolve));
  const body = ui.get('transcript');
  body.scrollHeight = 500;
  body.clientHeight = 100;
  body.scrollTop = 360;
  ui.show({ live: true, transcript: 'First lines' });
  assert.equal(body.scrollTop, 500);

  body.scrollTop = 20;
  body.scrollHeight = 500;
  ui.show({ live: true, transcript: 'First lines and more' });
  assert.equal(body.scrollTop, 20);
});

test('transcript copy failure uses the error notice', async () => {
  const ui = loadApp();
  await new Promise(resolve => setImmediate(resolve));
  ui.failCopy();
  ui.show({ live: true, transcript: 'Hello team' });
  await ui.get('copy-transcript').listeners.click();
  assert.equal(ui.notice(), 'Could not copy the transcript.');
  assert.equal(ui.get('notice').classes.error, true);
});
