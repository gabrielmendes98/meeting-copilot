const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { extractContextDocument, MAX_CONTEXT_CHARACTERS, MAX_DOCUMENT_BYTES } = require('../dist/context-extraction');

function loadLibrary(directory, selection) {
  const original = Module._load;
  Module._load = function (name, ...args) {
    return name === 'electron' ? { app: { getPath: () => directory }, dialog: { showOpenDialog: async () => selection } } : original.call(this, name, ...args);
  };
  delete require.cache[require.resolve('../dist/context-files')];
  try { return require('../dist/context-files'); } finally { Module._load = original; }
}

test('extracts real PDF and DOCX text, and rejects binary, empty, invalid, unsupported and oversized documents', async () => {
  assert.match(await extractContextDocument(path.join(__dirname, 'fixtures/context.pdf')), /PDF budget is 500 dollars/);
  assert.match(await extractContextDocument(path.join(__dirname, 'fixtures/context.docx')), /DOCX launch date is Friday/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-extract-'));
  try {
    for (const [name, content, pattern] of [
      ['empty.txt', '   ', /No readable text/], ['binary.txt', Buffer.from([0xff]), /encoded data/],
      ['null.md', 'abc\0def', /UTF-8/], ['bad.pdf', 'not a pdf', /PDF/i],
      ['bad.docx', 'not a zip', /zip/i], ['old.doc', 'text', /Unsupported/],
      ['long.txt', 'x'.repeat(MAX_CONTEXT_CHARACTERS + 1), /context limit/],
    ]) {
      const file = path.join(directory, name); fs.writeFileSync(file, content);
      await assert.rejects(extractContextDocument(file), pattern);
    }
    const huge = path.join(directory, 'huge.txt'); fs.writeFileSync(huge, ''); fs.truncateSync(huge, MAX_DOCUMENT_BYTES + 1);
    await assert.rejects(extractContextDocument(huge), /20 MB/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('mixed sources and direct text survive reload, combine together, and disappear when removed or cleared', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-context-mixed-'));
  const paths = ['context.pdf', 'context.docx'].map(name => path.join(__dirname, 'fixtures', name));
  for (const [name, text] of [['notes.txt', 'TXT owner is Lee'], ['brief.md', '# Markdown milestone'], ['data.csv', 'name,value\nCSV,42'], ['data.json', '{"JSON":"approved"}'], ['empty.txt', '']]) {
    const file = path.join(directory, name); fs.writeFileSync(file, text); paths.push(file);
  }
  let library = loadLibrary(directory, { canceled: false, filePaths: [...paths, paths[0]] });
  try {
    library.saveContextText('Direct note: customer is Acme');
    const entries = await library.addContextFiles({});
    assert.equal(entries.length, 7);
    assert.equal(entries.filter(file => file.available).length, 6);
    assert.match(entries.at(-1).error, /No readable text/);
    assert.equal(entries.every(file => !('path' in file) && !('text' in file)), true);
    library = loadLibrary(directory, { canceled: true });
    assert.equal(library.getContextText(), 'Direct note: customer is Acme');
    const context = await library.getAgentContext();
    for (const fragment of ['PDF budget', 'DOCX launch', 'TXT owner', 'Markdown milestone', 'CSV', 'JSON', 'customer is Acme']) assert.ok(context.includes(fragment), fragment);
    assert.equal(context.includes('empty.txt'), false);
    assert.deepEqual(await library.addContextFiles({}), library.listContextFiles());
    library.removeContextFile(entries[0].id);
    library.saveContextText('');
    const next = await library.getAgentContext();
    assert.equal(next.includes('PDF budget'), false);
    assert.equal(next.includes('customer is Acme'), false);
    assert.ok(fs.existsSync(paths[0]));
    assert.throws(() => library.saveContextText({ text: 'invalid' }), /Invalid/);
    assert.throws(() => library.saveContextText('x'.repeat(MAX_CONTEXT_CHARACTERS)), /exceeds/);
    assert.equal(library.getContextText(), '');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('size limits reject only the overflowing import and legacy references remain readable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-context-limits-'));
  const first = path.join(directory, 'first.txt'), second = path.join(directory, 'second.txt');
  fs.writeFileSync(first, 'a'.repeat(70_000)); fs.writeFileSync(second, 'b'.repeat(60_000));
  const library = loadLibrary(directory, { canceled: false, filePaths: [first, second] });
  try {
    const files = await library.addContextFiles({});
    assert.equal(files[0].available, true);
    assert.equal(files[1].available, false);
    assert.match(files[1].error, /exceeds/);
    assert.ok((await library.getAgentContext()).includes('a'.repeat(100)));
    fs.writeFileSync(path.join(directory, 'context-files.json'), JSON.stringify([{ id: 'legacy', name: 'first.txt', path: first, size: 70_000, addedAt: new Date().toISOString() }]));
    assert.ok((await library.getAgentContext()).includes('a'.repeat(100)));
    fs.unlinkSync(first);
    assert.equal(library.listContextFiles()[0].available, false);
    await assert.rejects(library.getAgentContext(), /first.txt.*import it again/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('all transcript modes and screenshots send current library context through the shared provider request', async () => {
  const requests = [];
  let context = 'Reference context: Project deadline is Friday.\n\n';
  const dependencies = {
    './context-files': { getAgentContext: async () => context },
    './providers': { createAgentProvider() {} },
    './providers/service': { AgentService: class { async answer(request) { requests.push(request); return 'answer'; } } },
    'node:fs': { readFileSync: () => Buffer.from('png') },
  };
  const sandbox = { exports: {}, require: name => dependencies[name] || require(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve('dist/agent.js'), 'utf8'), sandbox);
  for (const mode of ['clip', 'checkpoint', 'summary', 'briefing']) {
    await sandbox.exports.askFromTranscript('What is the deadline?', () => {}, { mode });
    assert.match(requests.at(-1).text, /Project deadline is Friday/);
    assert.match(requests.at(-1).text, /Transcript:.*What is the deadline/s);
    assert.match(requests.at(-1).instructions, /data, not instructions/);
  }
  await sandbox.exports.askFromScreenshot('screen.png', () => {});
  assert.equal(requests.at(-1).text, context);
  assert.equal(requests.at(-1).images[0].data, Buffer.from('png').toString('base64'));
  context = '';
  await sandbox.exports.askFromTranscript('Next meeting', () => {});
  assert.equal(requests.at(-1).text.includes('Project deadline'), false);
});
