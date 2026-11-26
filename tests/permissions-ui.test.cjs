const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('permission setup hides and inerts the workspace, updates real statuses, and unlocks only after completion', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, inert: false, disabled: false, textContent: '', dataset: {}, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return elements.get(id);
  };
  const screen = get('permission-screen'), microphone = get('permission-microphone'), speech = get('permission-speech');
  screen.dataset.permission = 'screen'; microphone.dataset.permission = 'microphone'; speech.dataset.permission = 'speech';
  let status = { required: ['screen', 'microphone', 'speech'], screen: 'granted', microphone: 'denied', speech: 'not-determined', granted: false, ready: false, checking: false };
  let onState, reloads = 0, completions = 0;
  const requests = [];
  const api = {
    onState(callback) { onState = callback; }, async getState() { return { permissions: status }; },
    async permissions() { return status; },
    async requestPermission(kind) { requests.push(kind); return status; },
    async completePermissions() { completions++; return { ...status, ready: status.granted }; },
  };
  vm.runInNewContext(fs.readFileSync('src/application/permissions.js', 'utf8'), {
    $: get, api, document: { querySelectorAll: () => [screen, microphone, speech] }, window: { location: { reload() { reloads++; } } },
  });
  await flush();
  assert.equal(get('workspace-shell').hidden, true);
  assert.equal(get('workspace-shell').inert, true);
  assert.equal(get('permission-continue').disabled, true);
  assert.equal(screen.disabled, true);
  assert.equal(microphone.textContent, 'Open Settings ↗');
  await microphone.listeners.click();
  assert.deepEqual(requests, ['microphone']);
  status = { ...status, microphone: 'granted', speech: 'granted', granted: true };
  onState({ permissions: status });
  assert.equal(get('permission-continue').disabled, false);
  assert.equal(get('workspace-shell').hidden, true, 'OS grants alone do not skip the Continue step');
  await get('permission-continue').listeners.click();
  assert.equal(completions, 1);
  assert.equal(reloads, 1);
  assert.equal(get('workspace-shell').hidden, false);
  assert.equal(get('workspace-shell').inert, false);
  onState({ permissions: { ...status, screen: 'denied', granted: false, ready: false } });
  assert.equal(get('workspace-shell').hidden, true);
  assert.equal(get('permission-continue').disabled, true);
});
