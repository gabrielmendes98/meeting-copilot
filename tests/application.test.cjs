const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { settingDefaults, validateSettings } = require('../dist/settings-config');

test('settings reject unsupported providers and conflicting shortcut aliases', () => {
  assert.throws(() => validateSettings({ ...settingDefaults, AGENT_PROVIDER: 'unknown' }), /supported agent/);
  assert.throws(() => validateSettings({ ...settingDefaults, STT_PROVIDER: 'unknown' }), /supported transcription/);
  assert.throws(() => validateSettings({ ...settingDefaults, CHECKPOINT_HOTKEY: 'Option+Space' }), /different shortcut/);
  assert.throws(() => validateSettings({ ...settingDefaults, AGENT_MODEL: ' ' }), /Enter a value/);
  assert.deepEqual(validateSettings({ ...settingDefaults, AGENT_API_KEY: '', ignored: 'untrusted' }), settingDefaults);
});

function withElectronMock(mock, load) {
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'electron' ? mock : original.call(this, name, ...args); };
  try { return load(); } finally { Module._load = original; }
}

test('settings encrypt storage, preserve keys on blank input, and never expose credentials to the UI', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-settings-test-'));
  const oldEnvironment = { ...process.env };
  let encryptionAvailable = true;
  const settings = withElectronMock({
    app: { getPath: () => directory },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (buffer) => {
        const text = buffer.toString();
        if (!text.startsWith('encrypted:')) throw new Error('invalid ciphertext');
        return text.slice(10);
      },
    },
  }, () => require('../dist/settings'));
  try {
    process.env.AGENT_API_KEY = 'original-key';
    process.env.STT_PROVIDER_API_KEY = 'speech-key';
    settings.saveSettings(validateSettings({ ...settingDefaults, AGENT_API_KEY: '', STT_PROVIDER_API_KEY: '' }));
    const storedText = fs.readFileSync(path.join(directory, 'settings.json'), 'utf8');
    assert.equal(storedText.includes('original-key'), false);
    assert.equal(storedText.includes('speech-key'), false);
    assert.equal(JSON.stringify(settings.publicSettings()).includes('original-key'), false);
    assert.equal(settings.publicSettings().hasAgentKey, true);
    delete process.env.AGENT_API_KEY;
    settings.loadSettings();
    assert.equal(process.env.AGENT_API_KEY, 'original-key');
    encryptionAvailable = false;
    assert.throws(() => settings.saveSettings({ ...settingDefaults, AGENT_API_KEY: 'replacement' }), /encryption is unavailable/);
    assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), storedText);
    assert.equal(process.env.AGENT_API_KEY, 'original-key');
    const corrupt = JSON.parse(storedText); corrupt.AGENT_PROVIDER = 'cursor'; corrupt.AGENT_API_KEY = Buffer.from('corrupt').toString('base64');
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(corrupt));
    assert.throws(() => settings.loadSettings(), /invalid ciphertext/);
    assert.equal(process.env.AGENT_PROVIDER, 'openai');
  } finally { process.env = oldEnvironment; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('context library deduplicates references and removes them without deleting originals', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-context-test-'));
  const source = path.join(directory, 'notes.txt'); fs.writeFileSync(source, 'Private meeting notes');
  const library = withElectronMock({
    app: { getPath: () => directory },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [source, source] }) },
  }, () => require('../dist/context-files'));
  try {
    const files = await library.addContextFiles({});
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'notes.txt');
    assert.equal(files[0].available, true);
    assert.equal('path' in files[0], false);
    assert.equal(fs.readFileSync(path.join(directory, 'context-files.json'), 'utf8').includes('Private meeting notes'), false);
    fs.renameSync(source, `${source}.moved`);
    assert.equal(library.listContextFiles()[0].available, false);
    assert.deepEqual(library.removeContextFile(files[0].id), []);
    assert.equal(fs.existsSync(`${source}.moved`), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
