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
  assert.equal(modes.list().modes.find(mode => mode.id === 'general').builtIn, true);
  modes.save(null, 'Project review', 'Focus on risks.', ['doc1', 'doc1', 'doc2']);
  const saved = modes.active();
  assert.equal(modes.list().modes.find(mode => mode.id === saved.id).builtIn, false);
  assert.throws(() => modes.save('general', 'Changed', 'Changed'), /Only custom/);
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


test('the default mode catalogue matches all eleven Cluely templates and each selection persists', context => {
  const file = path.join(temporaryDirectory(context), 'modes.json');
  const modes = new MeetingModes(file);
  const catalogue = modes.list().modes;
  assert.deepEqual(catalogue.map(mode => mode.title), [
    'General', 'Interview', 'Behavioral Interview', 'Coding Interview', 'System Design',
    'Case Interview', 'Recruiter Screen', 'Sales', 'Recruiting', 'Team Meet', 'Lecture',
  ]);
  assert.deepEqual(catalogue.filter(mode => mode.group === 'Looking for work').map(mode => mode.id), [
    'interview', 'behavioral-interview', 'coding-interview', 'system-design', 'case-interview', 'recruiter-screen',
  ]);
  const expectations = {
    interview: /resume[\s\S]*personal actions/,
    'behavioral-interview': /STAR[\s\S]*Never invent/,
    'coding-interview': /time and space complexity[\s\S]*dry run/,
    'system-design': /latency[\s\S]*backpressure[\s\S]*observability/,
    'case-interview': /MECE[\s\S]*formulas[\s\S]*recommendation/,
    'recruiter-screen': /compensation[\s\S]*hiring stages/,
    sales: /budget[\s\S]*objection[\s\S]*unverified functionality/,
    recruiting: /scorecard[\s\S]*supporting examples/,
    'team-meet': /dependencies[\s\S]*owner and deadline/,
    lecture: /formulas[\s\S]*practice questions/,
  };
  for (const mode of catalogue) {
    assert.ok(mode.description);
    assert.deepEqual(mode.referenceIds, [], 'templates do not inherit unrelated library files');
    if (mode.group === 'Looking for work') {
      assert.match(mode.instructions, /plausible, coherent example/);
      assert.doesNotMatch(mode.instructions, /provide explicit placeholders|clearly marked details/);
    }
    if (expectations[mode.id]) assert.match(mode.instructions, expectations[mode.id]);
    modes.choose(mode.id);
    const reopened = new MeetingModes(file); reopened.load();
    assert.equal(reopened.active().id, mode.id);
    assert.equal(reopened.active().instructions, mode.instructions);
  }
});

test('existing Meeting and Technical selections survive the mode catalogue update', context => {
  const file = path.join(temporaryDirectory(context), 'modes.json');
  fs.writeFileSync(file, JSON.stringify({selected:'meeting',custom:[]}));
  const modes = new MeetingModes(file); modes.load();
  assert.equal(modes.active().id, 'team-meet');
  assert.equal(modes.active().title, 'Team Meet');
  modes.choose('meeting');
  assert.equal(modes.list().selected, 'team-meet');
  modes.choose('technical');
  const reopened = new MeetingModes(file); reopened.load();
  assert.equal(reopened.active().id, 'technical');
  assert.equal(reopened.list().modes.some(mode=>mode.id==='technical'), true);
  reopened.choose('general');
  assert.equal(reopened.list().modes.some(mode=>mode.id==='technical'), false);
  reopened.save(null, 'Default behavior', '', []);
  assert.equal(reopened.active().instructions, '', 'custom modes may use the default assistant prompt');
});
