const { test } = require('node:test');
const assert = require('node:assert/strict');

const { chat, _parse } = require('./openai-compat.cjs');

function _res({ ok = true, status = 200, json, text }) {
  return {
    ok, status,
    json: async () => json,
    text: async () => (text != null ? text : JSON.stringify(json || {})),
  };
}

test('OAC-1: _parse extracts content + tool_calls from an OpenAI-shaped response', () => {
  const out = _parse({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: 'thinking',
        tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }],
      },
    }],
  });
  assert.equal(out.content, 'thinking');
  assert.equal(out.finishReason, 'tool_calls');
  assert.deepEqual(out.toolCalls, [{ id: 'c1', name: 'Read', arguments: '{"path":"a.txt"}' }]);
});

test('OAC-2: _parse on a content-only response yields empty toolCalls', () => {
  const out = _parse({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
  assert.equal(out.content, 'done');
  assert.deepEqual(out.toolCalls, []);
});

test('OAC-3: chat POSTs to <base>/chat/completions with model + tools and parses the reply', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return _res({ json: { choices: [{ message: { content: 'hi' } }] } });
  };
  const out = await chat({
    baseUrl: 'http://localhost:11434/v1', model: 'qwen', messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'Read' } }], fetchImpl,
  });
  assert.equal(captured.url, 'http://localhost:11434/v1/chat/completions');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, 'qwen');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(out.content, 'hi');
});

test('OAC-3b: chat forwards effort as reasoning_effort only when set', async () => {
  let captured = null;
  const fetchImpl = async (_url, opts) => { captured = JSON.parse(opts.body); return _res({ json: { choices: [{ message: { content: 'ok' } }] } }); };
  await chat({ baseUrl: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'x' }], effort: 'low', fetchImpl });
  assert.equal(captured.reasoning_effort, 'low', 'a set effort reaches the request body');
  await chat({ baseUrl: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'x' }], fetchImpl });
  assert.ok(!('reasoning_effort' in captured), 'absent effort is never sent (providers without support unaffected)');
});

test('OAC-4: api_key_env adds a bearer header; missing key throws provider-missing-api-key', async () => {
  let auth = null;
  const fetchImpl = async (_url, opts) => { auth = opts.headers.authorization; return _res({ json: { choices: [{ message: { content: 'ok' } }] } }); };
  await chat({ baseUrl: 'https://api.x.ai/v1', model: 'grok-2', messages: [], apiKeyEnv: 'XAI_KEY', env: { XAI_KEY: 'sk-123' }, fetchImpl });
  assert.equal(auth, 'Bearer sk-123');

  let thrown = null;
  try { await chat({ baseUrl: 'https://api.x.ai/v1', model: 'grok-2', messages: [], apiKeyEnv: 'XAI_KEY', env: {}, fetchImpl }); }
  catch (e) { thrown = e; }
  assert.equal(thrown && thrown.code, 'provider-missing-api-key');
});

test('OAC-5: non-2xx throws provider-http-error carrying status + host (not full url)', async () => {
  const fetchImpl = async () => _res({ ok: false, status: 500, text: 'boom' });
  let thrown = null;
  try { await chat({ baseUrl: 'http://localhost:11434/v1', model: 'qwen', messages: [], fetchImpl }); }
  catch (e) { thrown = e; }
  assert.equal(thrown.code, 'provider-http-error');
  assert.equal(thrown.details.status, 500);
  assert.equal(thrown.details.host, 'localhost:11434');
});

test('OAC-6: network failure throws provider-request-failed with host only', async () => {
  const fetchImpl = async () => { const e = new Error('refused'); e.code = 'ECONNREFUSED'; throw e; };
  let thrown = null;
  try { await chat({ baseUrl: 'http://localhost:11434/v1', model: 'qwen', messages: [], fetchImpl }); }
  catch (e) { thrown = e; }
  assert.equal(thrown.code, 'provider-request-failed');
  assert.equal(thrown.details.host, 'localhost:11434');
});

test('OAC-7: missing base_url / model throw before any fetch', async () => {
  let a = null; try { await chat({ model: 'm', messages: [] }); } catch (e) { a = e; }
  assert.equal(a.code, 'provider-no-base-url');
  let b = null; try { await chat({ baseUrl: 'http://x/v1', messages: [] }); } catch (e) { b = e; }
  assert.equal(b.code, 'provider-no-model');
});

test('OAC-8: _parse synthesizes a stable id when the provider omits tool_calls[].id', () => {
  const out = _parse({ choices: [{ message: { tool_calls: [
    { function: { name: 'Read', arguments: '{}' } },
    { function: { name: 'Grep', arguments: '{}' } },
  ] } }] });
  assert.deepEqual(out.toolCalls.map((t) => t.id), ['call_0', 'call_1']);
});

test('OAC-9: _parse captures token usage when present', () => {
  const out = _parse({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
  assert.deepEqual(out.usage, { tokens_in: 12, tokens_out: 5 });
  const none = _parse({ choices: [{ message: { content: 'x' } }] });
  assert.equal(none.usage, null);
});
