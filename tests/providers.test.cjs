const { test } = require('node:test');
const assert = require('node:assert/strict');
const OpenAI = require('openai').default;
const { readAgentConfig, missingAgentKeys } = require('../dist/providers/config');
const { AgentService } = require('../dist/providers/service');
const { OpenAIProvider } = require('../dist/providers/openai');
const { createAgentProvider } = require('../dist/providers');

test('default selects OpenAI and requires the shared agent key', () => {
  assert.deepEqual(readAgentConfig({}), { provider: 'openai', apiKey: '', model: 'gpt-4.1-mini' });
  assert.deepEqual(missingAgentKeys({}), ['AGENT_API_KEY']);
  assert.deepEqual(missingAgentKeys({ AGENT_API_KEY: 'key' }), []);
  assert.deepEqual(missingAgentKeys({ OPENAI_API_KEY: 'old-key', CURSOR_API_KEY: 'old-key' }), ['AGENT_API_KEY']);
});

test('both providers use AGENT_API_KEY and their own model defaults', () => {
  for (const [provider, model] of [['openai', 'gpt-4.1-mini'], ['cursor', 'composer-2.5']]) {
    const env = { AGENT_PROVIDER: ` ${provider.toUpperCase()} `, AGENT_API_KEY: ' key ' };
    assert.deepEqual(readAgentConfig(env), { provider, apiKey: 'key', model });
    assert.deepEqual(missingAgentKeys(env), []);
    assert.deepEqual(missingAgentKeys({ ...env, AGENT_API_KEY: ' ' }), ['AGENT_API_KEY']);
    assert.equal(readAgentConfig({ ...env, AGENT_MODEL: ' custom-model ' }).model, 'custom-model');
  }
});

test('removed and unknown providers are rejected', () => {
  for (const provider of ['openai-compatible', 'typo']) {
    assert.throws(() => readAgentConfig({ AGENT_PROVIDER: provider }), /Choose openai or cursor/);
  }
});

test('factory rejects missing credentials before loading an adapter', async () => {
  await assert.rejects(createAgentProvider(readAgentConfig({})), /AGENT_API_KEY is not set/);
});

test('service shares initialization and forwards provider-independent requests', async () => {
  let creates = 0, warms = 0, disposes = 0;
  const request = { instructions: 'summary', text: 'call' };
  const updates = [];
  const service = new AgentService(async () => {
    creates++;
    return {
      async warm() { warms++; },
      async answer(input, onText) { assert.equal(input, request); onText('Answer'); return 'Answer'; },
      async dispose() { disposes++; },
    };
  });
  await Promise.all([service.warm(), service.warm()]);
  assert.equal(await service.answer(request, text => updates.push(text)), 'Answer');
  assert.deepEqual(updates, ['Answer']);
  assert.equal(creates, 1);
  assert.equal(warms, 1);
  await service.dispose();
  await service.dispose();
  assert.equal(disposes, 1);
  await assert.rejects(service.warm(), /disposed/);
});

test('service cleans up a failed warm-up and retries initialization', async () => {
  let attempts = 0, disposed = 0;
  const service = new AgentService(async () => {
    const attempt = ++attempts;
    return {
      async warm() { if (attempt === 1) throw new Error('unavailable'); },
      async answer() { return 'ok'; },
      async dispose() { disposed++; },
    };
  });
  await assert.rejects(service.warm(), /unavailable/);
  await service.warm();
  assert.equal(attempts, 2);
  assert.equal(disposed, 1);
  await service.dispose();
  assert.equal(disposed, 2);
});

test('shutdown during initialization closes the eventual provider', async () => {
  let finishWarm, disposed = 0;
  const service = new AgentService(async () => ({
    warm: () => new Promise(resolve => { finishWarm = resolve; }),
    async answer() { assert.fail('must not answer after shutdown'); },
    async dispose() { disposed++; },
  }));
  const answering = service.answer({ instructions: 'test' }, () => {});
  await Promise.resolve();
  const closing = service.dispose();
  finishWarm();
  await closing;
  await assert.rejects(answering, /disposed/);
  assert.equal(disposed, 1);
});

function streamingClient(chunks, inspect) {
  return new OpenAI({ apiKey: 'test-key', baseURL: 'http://mock.invalid/v1', maxRetries: 0,
    fetch: async (url, init) => {
      inspect?.(String(url), JSON.parse(init.body));
      const events = chunks.map(choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`).join('');
      return new Response(events + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
}

test('OpenAI adapter streams full text, maps images, and sends no earlier context or tools', async () => {
  const updates = [], bodies = [];
  const client = streamingClient([
    { delta: { content: ' Hello' }, index: 0, finish_reason: null },
    { delta: { content: ' world ' }, index: 0, finish_reason: null },
    { delta: {}, index: 0, finish_reason: 'stop' },
  ], (url, body) => { assert.equal(url, 'http://mock.invalid/v1/chat/completions'); bodies.push(body); });
  const provider = new OpenAIProvider(readAgentConfig({ AGENT_API_KEY: 'key' }), client);
  assert.equal(await provider.answer({ instructions: 'Answer', text: 'Transcript' }, text => updates.push(text)), 'Hello world');
  assert.deepEqual(updates, [' Hello', ' Hello world ']);
  await provider.answer({ instructions: 'Screenshot only', images: [{ mimeType: 'image/png', data: 'cG5n' }] }, () => {});
  assert.deepEqual(bodies[0].messages, [
    { role: 'system', content: 'Answer' }, { role: 'user', content: [{ type: 'text', text: 'Transcript' }] },
  ]);
  assert.deepEqual(bodies[1].messages, [
    { role: 'system', content: 'Screenshot only' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } }] },
  ]);
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].model, 'gpt-4.1-mini');
  assert.equal(bodies[0].tools, undefined);
  await provider.dispose();
});

test('OpenAI adapter reports refusals, empty answers, truncated and filtered output', async () => {
  for (const [choice, pattern] of [
    [{ delta: { refusal: 'No' } }, /declined/],
    [{ delta: {} }, /empty response/],
    [{ delta: { content: 'partial' }, finish_reason: 'length' }, /output limit/],
    [{ delta: {}, finish_reason: 'content_filter' }, /content filter/],
  ]) {
    const provider = new OpenAIProvider(readAgentConfig({ AGENT_API_KEY: 'key' }), streamingClient([choice]));
    await assert.rejects(provider.answer({ instructions: 'Answer', text: 'test' }, () => {}), pattern);
    await provider.dispose();
  }
});

test('OpenAI adapter surfaces HTTP failures', async () => {
  const client = new OpenAI({ apiKey: 'test-key', maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 }),
  });
  const provider = new OpenAIProvider(readAgentConfig({ AGENT_API_KEY: 'key' }), client);
  await assert.rejects(provider.answer({ instructions: 'Answer', text: 'test' }, () => {}), /401/);
});

test('OpenAI adapter aborts active requests on shutdown', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const client = new OpenAI({ apiKey: 'test-key', maxRetries: 0,
    fetch: async (url, init) => {
      started();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  const provider = new OpenAIProvider(readAgentConfig({ AGENT_API_KEY: 'key' }), client);
  const answering = provider.answer({ instructions: 'Answer', text: 'test' }, () => {});
  await ready;
  await provider.dispose();
  await assert.rejects(answering, /abort/i);
});
