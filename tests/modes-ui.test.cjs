const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));

test('built-in modes open as editable copies and activate only after saving; custom modes retain identity and references', async () => {
  const elements = new Map();
  const calls = [];
  let onState, modeLoads = 0;
  function element() {
    return { value: '', hidden: false, checked: false, textContent: '', children: [], dataset: {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      focus() {}, querySelector() { return get('mode-submit'); },
      querySelectorAll() { return this.children.flatMap(label => label.children.filter(input => input.type === 'checkbox' && input.checked)); },
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const modes = { selected: 'system-design', modes: [
    { id: 'system-design', title: 'System design', instructions: 'Explain tradeoffs.', builtIn: true },
    { id: 'sales', title: 'Sales', description: 'Help with discovery.', instructions: 'Understand the buyer.', group: undefined, builtIn: true },
    { id: 'custom-mode', title: 'Customer design', instructions: 'Use customer requirements.', referenceIds: ['doc1'], builtIn: false },
  ] };
  const api = {
    onNewChat() {}, onAskShortcut() {}, onOpenPage() {}, onHistoryChanged() {}, onState(fn) { onState = fn; }, onModeChanged() {},
    async getState() { return { permissions: { ready: false } }; }, async listModes() { modeLoads++; return modes; },
    async listContext() { return [{ id: 'doc1', name: 'Architecture.pptx', available: true }, { id: 'doc2', name: 'server.ts', available: true }]; },
    async addContext() { return [...await this.listContext(), { id: 'doc3', name: 'Resume.docx', available: true }]; },
    async updateMode(...args) { calls.push(args); if (args[0] === 'choose') modes.selected = args[1]; return modes; },
  };
  vm.runInNewContext(fs.readFileSync('src/application/workflows.js', 'utf8'), {
    $, api, document: { createElement: element, createTextNode: text => ({ textContent: text }), querySelector: () => element() },
    Option: function (title, id) { this.textContent = title; this.value = id; },
    notify() {}, showPage() {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, window: { confirm: () => true },
  });
  function $(id) { return get(id); }
  await flush();
  assert.equal(modeLoads, 0, 'modes wait for permission readiness');
  onState({ permissions: { ready: true } });
  await flush();
  assert.equal(modeLoads, 1, 'late permission checks populate the catalogue');
  onState({ permissions: { ready: true } });
  await flush();
  assert.equal(modeLoads, 1, 'state updates do not repeatedly reload modes');
  assert.equal(get('edit-mode').textContent, 'Customize mode');
  await get('edit-mode').listeners.click();
  await flush();
  assert.equal(get('mode-name').value, 'System design copy');
  assert.equal(get('mode-instructions').value, 'Explain tradeoffs.');
  assert.equal(get('delete-mode').hidden, true);
  assert.equal(calls.length, 0);
  get('mode-name').value = 'Infrastructure review';
  get('mode-instructions').value = 'Explain costs and reliability.';
  get('mode-all-references').checked = false;
  get('mode-reference-options').children[1].children[0].checked = true;
  await get('mode-editor').listeners.submit({ preventDefault() {} });
  assert.equal(calls[0][0], 'save');
  assert.equal(calls[0][1], null);
  assert.equal(calls[0][2], 'Infrastructure review');
  assert.equal(calls[0][3], 'Explain costs and reliability.');
  assert.deepEqual(Array.from(calls[0][4]), ['doc2']);
  assert.equal(modes.modes[0].instructions, 'Explain tradeoffs.');
  modes.selected = 'custom-mode';
  get('meeting-mode').value = 'custom-mode';
  await get('meeting-mode').listeners.change();
  assert.equal(get('edit-mode').textContent, 'Edit mode');
  await get('edit-mode').listeners.click();
  await flush();
  assert.equal(get('mode-name').value, 'Customer design');
  assert.equal(get('delete-mode').hidden, false);
  assert.equal(get('mode-all-references').checked, false);
  assert.equal(get('mode-reference-options').children[0].children[0].checked, true);
  get('mode-instructions').value = 'Unsaved custom instructions';
  await get('mode-add-files').listeners.click();
  assert.equal(get('mode-instructions').value, 'Unsaved custom instructions');
  assert.equal(get('mode-reference-options').children[0].children[0].checked, true);
  assert.equal(get('mode-reference-options').children[2].children[0].checked, true);
  await get('mode-editor').listeners.submit({ preventDefault() {} });
  assert.equal(calls.at(-1)[1], 'custom-mode');
  assert.deepEqual(Array.from(calls.at(-1)[4]), ['doc1', 'doc3']);
  // Previewing a different template does not activate it until the explicit action.
  await get('mode-list').children.find(button => button.textContent.includes('Sales')).listeners.click();
  await flush();
  assert.equal(modes.selected, 'custom-mode');
  assert.equal(get('mode-description').textContent, 'Help with discovery.');
  assert.equal(get('mode-use-template').hidden, false);
  await get('mode-use-template').listeners.click();
  assert.equal(modes.selected, 'sales');
  assert.equal(get('mode-use-template').textContent, 'Active');
  assert.equal(get('mode-use-template').disabled, true);
  get('mode-instructions').listeners.input();
  assert.equal(get('mode-use-template').hidden, true, 'edited instructions must be saved as a custom mode');

});
