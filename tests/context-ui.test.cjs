const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('direct context UI loads notes, tracks unsaved edits, saves and clears text, and keeps failed saves editable', async () => {
  const elements = new Map(), saves = [];
  function element() {
    return { value: '', textContent: '', hidden: false, disabled: false, children: [], listeners: {},
      classList: { toggle() {}, add() {} },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }, setAttribute() {},
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('settings-form').elements = { STT_PROVIDER: element(), AGENT_PROVIDER: element() };
  let rejectSave = false;
  const api = {
    onState() {}, async getState() { throw new Error('context-only fixture'); },
    async listContext() { return [{ id: '1', name: 'notes.txt', size: 100, addedAt: '2026-10-12', available: true }]; },
    async getContextText() { return 'Saved project notes'; },
    async saveContextText(text) { if (rejectSave) throw new Error('Context exceeds limit'); saves.push(text); return text; },
  };
  vm.runInNewContext(fs.readFileSync('src/application/app.js', 'utf8'), {
    window: { meetingCopilot: api }, document: { getElementById: get, querySelectorAll: () => [], createElement: element },
    setTimeout() {}, clearTimeout() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('context-text').value, 'Saved project notes');
  assert.equal(get('context-text').disabled, false);
  assert.equal(get('save-context-text').disabled, true);
  assert.equal(get('context-list').children[0].children[2].textContent, 'Ready');
  get('context-text').value = 'Updated notes'; get('context-text').listeners.input();
  assert.equal(get('save-context-text').disabled, false);
  assert.match(get('context-text-hint').textContent, /Unsaved/);
  await get('context-text-form').listeners.submit({ preventDefault() {} });
  assert.deepEqual(saves, ['Updated notes']);
  assert.equal(get('save-context-text').disabled, true);
  get('context-text').value = ''; get('context-text').listeners.input();
  await get('context-text-form').listeners.submit({ preventDefault() {} });
  assert.deepEqual(saves, ['Updated notes', '']);
  rejectSave = true; get('context-text').value = 'Too much'; get('context-text').listeners.input();
  await get('context-text-form').listeners.submit({ preventDefault() {} });
  assert.equal(get('context-text').value, 'Too much');
  assert.equal(get('save-context-text').disabled, false);
  assert.match(get('notice').textContent, /exceeds limit/);
});
