const test = require('node:test');
const assert = require('node:assert/strict');
const { isInterviewPrompt, QuietTurn } = require('../dist/auto-answer');

test('recognizes questions and interview instructions, waits through incomplete prompts', () => {
  for (const text of ['Walk me through a production incident.', 'Como você testaria isso?', 'Why this database']) {
    assert.equal(isInterviewPrompt(text), true, text);
  }
  for (const text of ['', 'Thanks for joining.', 'How would you handle it if', 'Tell me about the…']) {
    assert.equal(isInterviewPrompt(text), false, text);
  }
});

test('renewed activity invalidates pending transcript work and stopping cancels the deadline', async () => {
  const turn = new QuietTurn(5);
  const fired = [];
  const activity = () => turn.activity(current => fired.push(current));
  activity();
  activity();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(fired.length, 1);
  assert.equal(fired[0](), true);
  activity();
  assert.equal(fired[0](), false);
  turn.cancel();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(fired.length, 1);
});
