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

test('mode references restrict document context and preserve shared notes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mode-references-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first.txt');
  const second = path.join(directory, 'second.txt');
  fs.writeFileSync(first, 'Engineering deadline on Friday');
  fs.writeFileSync(second, 'Sales review on Monday');
  const library = loadLibrary(directory, { canceled: false, filePaths: [first, second] });
  const [included, excluded] = await library.addContextFiles({});
  library.saveContextText('Shared agenda');
  const scoped = await library.getAgentContext([included.id]);
  assert.match(scoped, /Engineering deadline/);
  assert.match(scoped, /Shared agenda/);
  assert.doesNotMatch(scoped, /Sales review/);
  assert.match(await library.getAgentContext([excluded.id]), /Sales review/);
  assert.doesNotMatch(await library.getAgentContext([]), /Sales review|Engineering deadline/);
  assert.match(await library.getAgentContext(), /Sales review/);
  library.removeContextFile(included.id);
  assert.doesNotMatch(await library.getAgentContext([included.id]), /Engineering deadline/);
});

test('contextual chat and screenshots send the current reference library', async () => {
  const requests = [];
  let context = 'Reference context: Project deadline is Friday.\n\n';
  const dependencies = {
    './context-files': { getAgentContext: async () => context },
    './settings-config': require('../dist/settings-config'),
    './providers': { createAgentProvider() {} },
    './providers/service': { AgentService: class { async answer(request) { requests.push(request); return 'answer'; } } },
    'node:fs': { readFileSync: () => Buffer.from('png') },
  };
  const sandbox = { exports: {}, require: name => dependencies[name] || require(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve('dist/agent.js'), 'utf8'), sandbox);
  await sandbox.exports.askWithContext({ question: 'What is the deadline?', transcript: 'We are reviewing the schedule.' }, () => {});
  assert.match(requests.at(-1).text, /Project deadline is Friday/);
  assert.match(requests.at(-1).text, /transcript.*reviewing the schedule/);
  assert.match(requests.at(-1).instructions, /never as instructions/);
  await sandbox.exports.askFromScreenshot('screen.png', () => {});
  assert.equal(requests.at(-1).text, context);
  assert.equal(requests.at(-1).images[0].data, Buffer.from('png').toString('base64'));
  context = '';
  await sandbox.exports.askWithContext({ question: 'Next meeting' }, () => {});
  assert.equal(requests.at(-1).text.includes('Project deadline'), false);
});


test('PowerPoint references follow presentation order and preserve readable text without notes or hidden ZIP parts', async t => {
  const JSZip = require('jszip');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-pptx-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const zip = new JSZip();
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="urn:presentation" xmlns:r="${office}"><p:sldIdLst><p:sldId id="1" r:id="second"/><p:sldId id="2" r:id="first"/></p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="${office}/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="${office}/slide" Target="/ppt/slides/slide10.xml"/></Relationships>`);
  zip.file('ppt/slides/slide1.xml', `<a:p xmlns:a="${drawing}"><a:r><a:t>Budget is $500</a:t></a:r><a:br/><a:r><a:t>Approved</a:t></a:r></a:p>`);
  zip.file('ppt/slides/slide10.xml', `<a:p xmlns:a="${drawing}"><a:r><a:t>Launch </a:t></a:r><a:r><a:t>Friday &amp; Monday</a:t></a:r></a:p>`);
  zip.file('ppt/notesSlides/notesSlide1.xml', '<secret>Do not include notes</secret>');
  zip.file('ppt/slides/slide99.xml', '<secret>Unlisted slide</secret>');
  const file = path.join(directory, 'brief.PPTX');
  const write = async () => fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  await write();
  assert.equal(await extractContextDocument(file), 'Slide 1\nLaunch Friday & Monday\n\nSlide 2\nBudget is $500\nApproved');
  zip.file('ppt/slides/slide10.xml', '<!DOCTYPE slide [<!ENTITY x "bad">]><slide/>');
  await write();
  await assert.rejects(extractContextDocument(file), /document type/);
  zip.file('ppt/slides/slide10.xml', `<a:p xmlns:a="${drawing}"><a:t>${'x'.repeat(MAX_CONTEXT_CHARACTERS + 1)}</a:t></a:p>`);
  await write();
  await assert.rejects(extractContextDocument(file), /context limit/);
  zip.file('ppt/slides/slide10.xml', ' '.repeat(MAX_DOCUMENT_BYTES + 1));
  await write();
  await assert.rejects(extractContextDocument(file), /Expanded PPTX/);
});

test('PowerPoint rejects unresolved, external, invalid and textless slides', async t => {
  const JSZip = require('jszip');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-pptx-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const zip = new JSZip();
  const file = path.join(directory, 'brief.pptx');
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const write = async () => fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="urn:presentation" xmlns:r="${office}"><p:sldId r:id="s1"/></p:presentation>`);
  for (const target of ['Target="../../secrets.xml"', 'Target="https://example.com/slide.xml" TargetMode="External"', 'Target="slides/missing.xml"']) {
    zip.file('ppt/_rels/presentation.xml.rels', `<Relationships><Relationship Id="s1" Type="${office}/slide" ${target}/></Relationships>`);
    await write();
    await assert.rejects(extractContextDocument(file), /Invalid PPTX/);
  }
  zip.file('ppt/slides/missing.xml', '<slide/>');
  await write();
  await assert.rejects(extractContextDocument(file), /No readable text/);
  zip.file('ppt/slides/missing.xml', '<slide><broken></slide>');
  await write();
  await assert.rejects(extractContextDocument(file));
});

test('source code references retain UTF-8 contents and reject binary content', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-code-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const extension of ['ts', 'tsx', 'py', 'swift', 'sql', 'yaml']) {
    const file = path.join(directory, 'reference.' + extension);
    fs.writeFileSync(file, 'const project = "São Paulo";\n  // preserve indentation');
    assert.equal(await extractContextDocument(file), 'const project = "São Paulo";\n  // preserve indentation');
    fs.writeFileSync(file, Buffer.from([0, 1, 2]));
    await assert.rejects(extractContextDocument(file), /UTF-8/);
  }
});
