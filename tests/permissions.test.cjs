const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionGate } = require('../dist/permissions');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-permission-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'setup.json');
  const media = { screen: 'not-determined', microphone: 'not-determined' };
  const calls = [];
  let speech = 'not-determined', local = true, fail = false;
  const dependencies = {
    supported: true, readMedia: kind => media[kind], needsSpeech: () => local,
    async readSpeech(request) { calls.push(['speech', request]); if (fail) throw new Error('helper missing'); if (request) speech = 'granted'; return speech; },
    async requestMedia(kind) { calls.push(['media', kind]); media[kind] = 'granted'; },
    async openSettings(kind) { calls.push(['settings', kind]); },
  };
  return { file, media, calls, dependencies, gate: new PermissionGate(file, dependencies),
    setSpeech: value => { speech = value; }, setLocal: value => { local = value; }, fail: () => { fail = true; } };
}

test('setup cannot complete until every required OS permission is granted; completion persists with private storage', async t => {
  const f = fixture(t);
  await f.gate.load();
  await f.gate.refresh();
  assert.equal(f.gate.snapshot().ready, false);
  assert.deepEqual(f.calls, [['speech', false]], 'status checks never request access');
  await assert.rejects(f.gate.complete(), /Approve/);
  assert.equal(fs.existsSync(f.file), false);
  await f.gate.request('screen');
  await f.gate.request('microphone');
  assert.equal(f.gate.snapshot().granted, false);
  await f.gate.request('speech');
  assert.equal(f.gate.snapshot().granted, true);
  assert.equal(f.gate.snapshot().ready, false, 'user still needs to continue');
  await f.gate.complete();
  assert.equal(f.gate.snapshot().ready, true);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const reopened = new PermissionGate(f.file, f.dependencies);
  await reopened.load(); await reopened.refresh();
  assert.equal(reopened.snapshot().ready, true);
  f.media.screen = 'denied';
  assert.equal(reopened.snapshot().ready, false, 'revocation overrides previous completion');
});

test('denied permissions open the matching System Settings pane and cannot be bypassed', async t => {
  const f = fixture(t);
  f.media.screen = 'denied'; f.media.microphone = 'restricted'; f.setSpeech('denied');
  await f.gate.refresh();
  for (const kind of ['screen', 'microphone', 'speech']) await f.gate.request(kind);
  assert.deepEqual(f.calls.filter(call => call[0] === 'settings').map(call => call[1]), ['screen', 'microphone', 'speech']);
  assert.equal(f.calls.some(call => call[0] === 'media'), false);
  assert.equal(f.gate.snapshot().ready, false);
  await assert.rejects(f.gate.request('camera'), /Unknown permission/);
});

test('cloud transcription does not require speech access; switching to local re-locks until it is granted', async t => {
  const f = fixture(t);
  f.setLocal(false); f.media.screen = f.media.microphone = 'granted';
  await f.gate.refresh(); await f.gate.complete();
  assert.deepEqual(f.gate.snapshot().required, ['screen', 'microphone']);
  assert.equal(f.gate.snapshot().ready, true);
  assert.equal(f.calls.length, 0);
  f.setLocal(true);
  assert.equal(f.gate.snapshot().ready, false);
  f.setSpeech('granted'); await f.gate.refresh();
  assert.equal(f.gate.snapshot().ready, true);
  f.setSpeech('denied'); await f.gate.refresh();
  assert.equal(f.gate.snapshot().ready, false);
});

test('missing speech helper and corrupt completion files fail closed', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'invalid JSON');
  await f.gate.load(); f.fail(); await f.gate.refresh();
  assert.match(f.gate.snapshot().error, /speech helper/);
  assert.equal(f.gate.snapshot().ready, false);
  assert.equal(f.gate.snapshot().speech, 'unknown');
  await assert.rejects(f.gate.complete(), /Approve/);
});
