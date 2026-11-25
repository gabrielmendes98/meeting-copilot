const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingHistory } = require('../dist/meeting-history');
const { MeetingModes } = require('../dist/meeting-modes');

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-copilot-history-'));
  context.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

test('history survives restart, searches across editable notes and the original transcript, and exports Markdown', (context) => {
  const directory = temporaryDirectory(context);
  const initial = new MeetingHistory(directory);
  const older = initial.add(10_000, 'Discussed the deployment delay.');
  const newest = initial.add(20_000, 'Discussed pricing.');
  initial.edit(older.id, 'System review', 'Ana owns the rollback plan.');

  const reopened = new MeetingHistory(directory);
  assert.deepEqual(reopened.list().map(item => item.id), [newest.id, older.id]);
  assert.deepEqual(reopened.list('ROLLBACK deployment').map(item => item.id), [older.id]);
  assert.equal(reopened.get(older.id).transcript, older.transcript);
  assert.match(reopened.markdown(older.id), /# System review[\s\S]*Ana owns[\s\S]*deployment delay/);
  assert.equal(fs.statSync(path.join(directory, older.id + '.json')).mode & 0o777, 0o600);

  fs.writeFileSync(path.join(directory, newest.id + '.json'), 'malformed');
  assert.deepEqual(reopened.list().map(item => item.id), [older.id]);
  assert.throws(() => reopened.edit(older.id, ' ', ''), /Title/);
  assert.throws(() => reopened.get('../settings'), /identifier/);
  reopened.delete(older.id);
  assert.throws(() => reopened.get(older.id), /no longer in history/);
});

test('custom modes persist selection and editing, with a built-in fallback on deletion', (context) => {
  const file = path.join(temporaryDirectory(context), 'modes.json');
  const modes = new MeetingModes(file);
  assert.equal(modes.active().id, 'general');
  modes.save(null, 'Project review', 'Focus on risks.', ['doc1', 'doc1', 'doc2']);
  const saved = modes.active();
  modes.choose('technical');
  assert.equal(modes.active().id, 'technical');

  const reopened = new MeetingModes(file);
  reopened.load();
  assert.equal(reopened.active().id, 'technical');
  reopened.save(saved.id, 'Project review', 'Focus on risks and decisions.');
  assert.equal(reopened.active().instructions, 'Focus on risks and decisions.');
  assert.deepEqual(reopened.active().referenceIds, ['doc1', 'doc2']);
  reopened.save(saved.id, 'Project review', 'Focus on risk.', null);
  assert.equal(reopened.active().referenceIds, undefined);
  reopened.save(saved.id, 'Project review', 'Focus on risk.', []);
  assert.deepEqual(reopened.active().referenceIds, []);
  assert.throws(() => reopened.save(saved.id, 'Project review', 'Focus on risk.', [null]), /Invalid mode reference/);
  assert.throws(() => reopened.remove('general'), /custom/);
  reopened.remove(saved.id);
  assert.equal(reopened.active().id, 'general');
  assert.throws(() => reopened.choose(saved.id), /Unknown/);
});
