const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readTranscriptionConfig, pickTranscriptionProvider, missingTranscriptionKeys } = require('../dist/transcription/config');
const { createTranscriptionProvider } = require('../dist/transcription');
const { CloudTranscriptionProvider } = require('../dist/transcription/cloud');
const { MacosTranscriptionProvider } = require('../dist/transcription/macos');
const { TranscriptionService } = require('../dist/transcription/service');
const { TranscribeError } = require('../dist/transcription/errors');

function wavFixture(t, size = 128) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-stt-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.wav');
  fs.writeFileSync(file, Buffer.alloc(size));
  return file;
}

test('auto selects OpenAI with the STT key and macOS without it, independently of the agent', () => {
  assert.equal(pickTranscriptionProvider({}), 'macos');
  assert.equal(pickTranscriptionProvider({ AGENT_API_KEY: 'key', AGENT_PROVIDER: 'openai' }), 'macos');
  assert.equal(pickTranscriptionProvider({ STT_PROVIDER_API_KEY: 'key' }), 'openai');
  assert.equal(pickTranscriptionProvider({ STT_PROVIDER_API_KEY: ' ' }), 'macos');
  assert.equal(pickTranscriptionProvider({ OPENAI_API_KEY: 'old-key', GROQ_API_KEY: 'old-key' }), 'macos');
});

test('explicit selection, aliases, and key validation share one configuration resolver', () => {
  for (const provider of ['macos', 'speech', 'local']) {
    assert.deepEqual(readTranscriptionConfig({ STT_PROVIDER: ` ${provider.toUpperCase()} ` }), { provider: 'macos', mode: 'live' });
    assert.deepEqual(missingTranscriptionKeys({ STT_PROVIDER: provider }), []);
  }
  for (const [provider, key, model] of [
    ['openai', 'STT_PROVIDER_API_KEY', 'gpt-4o-mini-transcribe'],
    ['groq', 'STT_PROVIDER_API_KEY', 'whisper-large-v3-turbo'],
  ]) {
    const env = { STT_PROVIDER: provider, [key]: ' secret ' };
    const config = readTranscriptionConfig(env);
    assert.equal(config.provider, provider);
    assert.equal(config.apiKey, 'secret');
    assert.equal(config.model, model);
    assert.equal(config.mode, 'clip');
    assert.deepEqual(missingTranscriptionKeys(env), []);
    assert.deepEqual(missingTranscriptionKeys({ STT_PROVIDER: provider }), [key]);
    assert.deepEqual(missingTranscriptionKeys({ STT_PROVIDER: provider, AGENT_API_KEY: 'agent-key' }), [key]);
    assert.deepEqual(missingTranscriptionKeys({ STT_PROVIDER: provider, [key]: ' ' }), [key]);
    assert.equal(readTranscriptionConfig({ ...env, AGENT_PROVIDER: 'cursor', AGENT_API_KEY: 'cursor-key' }).apiKey, 'secret');
  }
  assert.throws(() => readTranscriptionConfig({ STT_PROVIDER: 'typo' }), /Unknown STT_PROVIDER/);
});

test('factory creates the selected adapter and rejects missing cloud keys', async () => {
  for (const provider of ['openai', 'groq']) {
    await assert.rejects(createTranscriptionProvider(readTranscriptionConfig({ STT_PROVIDER: provider })), /STT_PROVIDER_API_KEY is not set/);
    const adapter = await createTranscriptionProvider(readTranscriptionConfig({ STT_PROVIDER: provider, STT_PROVIDER_API_KEY: 'key' }));
    assert.ok(adapter instanceof CloudTranscriptionProvider);
    assert.equal(adapter.createLiveSession, undefined);
    await adapter.dispose();
  }
  const adapter = await createTranscriptionProvider(readTranscriptionConfig({ STT_PROVIDER: 'macos' }));
  assert.ok(adapter instanceof MacosTranscriptionProvider);
  assert.equal(typeof adapter.createLiveSession, 'function');
  await adapter.dispose();
});

test('cloud adapter maps both providers to multipart English requests', async t => {
  const wav = wavFixture(t);
  for (const name of ['openai', 'groq']) {
    const config = readTranscriptionConfig({ STT_PROVIDER: name, STT_PROVIDER_API_KEY: `${name}-key` });
    const provider = new CloudTranscriptionProvider(config, async (url, init) => {
      assert.equal(url, name === 'openai' ? 'https://api.openai.com/v1/audio/transcriptions' : 'https://api.groq.com/openai/v1/audio/transcriptions');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, `Bearer ${name}-key`);
      assert.equal(init.body.get('model'), config.model);
      assert.equal(init.body.get('language'), 'en');
      assert.equal(init.body.get('response_format'), 'json');
      assert.equal(init.body.get('file').name, 'clip.wav');
      assert.equal(init.body.get('file').type, 'audio/wav');
      assert.equal(init.body.get('file').size, 128);
      return Response.json({ text: ' Hello meeting. ' });
    });
    assert.equal(await provider.transcribe(wav), 'Hello meeting.');
    await provider.dispose();
  }
});

test('cloud adapter rejects empty audio, malformed output, and HTTP failures', async t => {
  const config = readTranscriptionConfig({ STT_PROVIDER_API_KEY: 'key' });
  const empty = wavFixture(t, 44);
  const provider = new CloudTranscriptionProvider(config, async () => { assert.fail('must not upload empty audio'); });
  await assert.rejects(provider.transcribe(empty), /audio is empty/);
  const wav = wavFixture(t);
  for (const [response, pattern] of [
    [Response.json({ text: ' ' }), /came back empty/],
    [Response.json({ text: 123 }), /came back empty/],
    [Response.json(null), /came back empty/],
    [new Response('bad json'), /Transcription failed/],
    [new Response('invalid key', { status: 401 }), /STT failed \(401\): invalid key/],
  ]) {
    const adapter = new CloudTranscriptionProvider(config, async () => response);
    await assert.rejects(adapter.transcribe(wav), pattern);
  }
});

test('cloud shutdown cancels an in-flight upload', async t => {
  const wav = wavFixture(t);
  let signal;
  const provider = new CloudTranscriptionProvider(readTranscriptionConfig({ STT_PROVIDER_API_KEY: 'key' }), async (url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const job = provider.transcribe(wav);
  await provider.dispose();
  await assert.rejects(job, /cancelled or timed out/);
  assert.equal(signal.aborted, true);
});

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stderr = new PassThrough();
  proc.kill = () => { proc.killed = true; return true; };
  return proc;
}

test('macOS clip adapter launches the helper, trims text, and removes its output', async t => {
  const wav = wavFixture(t);
  const proc = fakeProcess();
  const provider = new MacosTranscriptionProvider(() => '/test/Speech.app', (command, args) => {
    assert.equal(command, 'open');
    assert.deepEqual(args, ['-W', '-n', '-a', '/test/Speech.app', '--args', wav, `${wav}.stt.json`]);
    return proc;
  });
  const job = provider.transcribe(wav);
  fs.writeFileSync(`${wav}.stt.json`, JSON.stringify({ ok: true, text: ' Local speech. ' }));
  proc.emit('close', 0);
  assert.equal(await job, 'Local speech.');
  assert.equal(fs.existsSync(`${wav}.stt.json`), false);
  await provider.dispose();
});

test('macOS adapter reports helper errors and cancels processes on disposal', async t => {
  const wav = wavFixture(t);
  const proc = fakeProcess();
  const provider = new MacosTranscriptionProvider(() => '/test/Speech.app', () => proc);
  const job = provider.transcribe(wav);
  proc.emit('error', new Error('could not launch'));
  await assert.rejects(job, /could not launch/);
  const proc2 = fakeProcess();
  const adapter = new MacosTranscriptionProvider(() => '/test/Speech.app', () => proc2);
  const pending = adapter.transcribe(wav);
  await adapter.dispose();
  await assert.rejects(pending, /cancelled/);
  assert.equal(proc2.killed, true);
});

test('macOS adapter owns its live session and disposes it', async () => {
  let stopped = 0;
  const session = { async stop() { stopped++; } };
  const provider = new MacosTranscriptionProvider(() => '', () => {}, () => session);
  assert.equal(provider.createLiveSession(), session);
  assert.equal(provider.createLiveSession(), session);
  await provider.dispose();
  await provider.dispose();
  assert.equal(stopped, 1);
});

test('service shares initialization, supports live lifecycle, and forwards exit errors', async () => {
  let creates = 0, disposed = 0;
  const live = {
    active: false, onUnexpectedExit: null,
    async start() { this.active = true; },
    async stop() { this.active = false; },
    async flushAndTranscript() { return 'Whole call'; },
  };
  const service = new TranscriptionService(async () => {
    creates++;
    return {
      async transcribe(file) { return file; },
      createLiveSession() { return live; },
      async dispose() { disposed++; await live.stop(); },
    };
  }, () => ({ provider: 'macos', mode: 'live' }));
  assert.equal(service.supportsLive, true);
  assert.equal(service.active, false);
  assert.deepEqual(await Promise.all([service.transcribe('one.wav'), service.transcribe('two.wav')]), ['one.wav', 'two.wav']);
  assert.equal(creates, 1);
  await service.start();
  assert.equal(service.active, true);
  assert.equal(await service.flushAndTranscript(), 'Whole call');
  let received;
  service.onUnexpectedExit = err => { received = err; };
  const error = new Error('helper exited');
  live.onUnexpectedExit(error);
  assert.equal(received, error);
  await service.stop();
  assert.equal(service.active, false);
  await service.start();
  const closing = service.dispose();
  assert.equal(live.active, false, 'shutdown must stop the live helper immediately');
  await closing;
  await service.dispose();
  assert.equal(disposed, 1);
  await assert.rejects(service.transcribe('clip.wav'), /disposed/);
});

test('service retries factory failures and rejects unavailable live capability', async () => {
  let attempts = 0;
  const config = readTranscriptionConfig({ STT_PROVIDER_API_KEY: 'key' });
  const service = new TranscriptionService(async () => {
    if (++attempts === 1) throw new TranscribeError('unavailable');
    return { async transcribe() { return 'ok'; }, async dispose() {} };
  }, () => config);
  assert.equal(service.supportsLive, false);
  await assert.rejects(service.transcribe('clip.wav'), /unavailable/);
  assert.equal(await service.transcribe('clip.wav'), 'ok');
  await assert.rejects(service.start(), /does not support live/);
  await assert.rejects(service.flushAndTranscript(), /Not listening/);
  await service.dispose();
});

test('shutdown during adapter creation disposes the adapter without starting a request', async () => {
  let finishCreate, disposed = 0;
  const service = new TranscriptionService(() => new Promise(resolve => { finishCreate = resolve; }));
  const job = service.transcribe('clip.wav');
  const closing = service.dispose();
  finishCreate({ async transcribe() { assert.fail('must not transcribe after shutdown'); }, async dispose() { disposed++; } });
  await closing;
  await assert.rejects(job, /disposed/);
  assert.equal(disposed, 1);
});
