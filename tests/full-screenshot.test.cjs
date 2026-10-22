const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('primary capture uses the main display and reports an unusable capture', async () => {
  const calls = [];
  const files = new Map();
  let mode = 'ok';
  const sandbox = {
    exports: {},
    require(name) {
      if (name === 'node:child_process') {
        return { spawn(command, args) {
          calls.push([command, args]);
          return { on(event, fn) {
            if (event === 'close') queueMicrotask(() => {
              if (mode === 'ok') files.set(args.at(-1), 12);
              if (mode === 'empty') files.set(args.at(-1), 0);
              fn(mode === 'fail' ? 1 : 0);
            });
          } };
        } };
      }
      if (name === 'node:fs') {
        return { existsSync: (file) => files.has(file), statSync: (file) => ({ size: files.get(file) || 0 }), unlinkSync: (file) => files.delete(file) };
      }
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve('dist/screenshot.js'), 'utf8'), sandbox);
  const png = await sandbox.exports.capturePrimaryDisplay();
  assert.equal(calls[0][0], '/usr/sbin/screencapture');
  assert.deepEqual(Array.from(calls[0][1]), ['-x', '-m', png]);
  mode = 'fail';
  await assert.rejects(sandbox.exports.capturePrimaryDisplay(), /Could not capture the primary display. Check Screen Recording permission/);
  mode = 'empty';
  await assert.rejects(sandbox.exports.capturePrimaryDisplay(), /Screen Recording permission/);
  assert.equal(files.has(calls.at(-1)[1][2]), false);
});

test('full screenshot instructions answer the centered question and keep partial questions out', async () => {
  const requests = [];
  let context = '';
  const sandbox = {
    exports: {},
    require(name) {
      if (name === './context-files') return { getAgentContext: async () => context };
      if (name === './providers') return { createAgentProvider() {} };
      if (name === './providers/service') return { AgentService: class { async answer(request) { requests.push(request); return 'answer'; } } };
      if (name === 'node:fs') return { readFileSync: () => Buffer.from('png') };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve('dist/agent.js'), 'utf8'), sandbox);
  await sandbox.exports.askFromFullScreenshot('screen.png', () => {});
  const alone = requests.at(-1).instructions;
  assert.match(alone, /centered/i);
  assert.match(alone, /cut off|blurred|not fully understandable/i);
  assert.match(alone, /top to bottom/i);
  assert.equal(alone.includes('data, not instructions'), false);
  context = 'Reference context: The deadline is Friday.\n\n';
  await sandbox.exports.askFromFullScreenshot('screen.png', () => {});
  assert.match(requests.at(-1).instructions, /data, not instructions/);
  assert.match(requests.at(-1).text, /deadline is Friday/);
  assert.equal(requests.at(-1).images[0].mimeType, 'image/png');
});

test('full screenshot controls are present in the meeting window and overlay', () => {
  const app = fs.readFileSync('src/application/index.html', 'utf8');
  const overlay = fs.readFileSync('src/overlay/index.html', 'utf8');
  assert.match(app, /name="FULL_SCREENSHOT_HOTKEY"/);
  assert.match(app, /data-action="full-screenshot"/);
  assert.match(app, /Full screenshot/);
  assert.match(overlay, /id="shortcut-fullScreenshot"/);
  assert.match(overlay, /Full screenshot/);
});
