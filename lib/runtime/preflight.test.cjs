const { test } = require('node:test');
const assert = require('node:assert/strict');

const { preflight, assertPreflight, _isLocal } = require('./preflight.cjs');

function _res({ ok = true, status = 200, json }) {
  return { ok, status, json: async () => json };
}

test('PF-1: reachable + model present ⇒ ok', async () => {
  const fetchImpl = async () => _res({ json: { data: [{ id: 'qwen2.5-coder:32b' }, { id: 'llama3' }] } });
  const r = await preflight({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:32b', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.reachable, true);
  assert.equal(r.modelPresent, true);
  assert.deepEqual(r.models, ['qwen2.5-coder:32b', 'llama3']);
});

test('PF-2: unreachable server ⇒ not ok with `ollama serve` hint for localhost', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await preflight({ baseUrl: 'http://localhost:11434/v1', model: 'qwen', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reachable, false);
  assert.match(r.hint, /ollama serve/);
});

test('PF-3: reachable but model missing ⇒ `ollama pull` hint', async () => {
  const fetchImpl = async () => _res({ json: { data: [{ id: 'llama3' }] } });
  const r = await preflight({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5', fetchImpl });
  assert.equal(r.reachable, true);
  assert.equal(r.modelPresent, false);
  assert.equal(r.ok, false);
  assert.match(r.hint, /ollama pull qwen3\.5/);
});

test('PF-4: remote host missing model gives a non-ollama hint', async () => {
  const fetchImpl = async () => _res({ json: { data: [{ id: 'gpt-4o' }] } });
  const r = await preflight({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-9', fetchImpl });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.hint, /ollama/);
});

test('PF-5: assertPreflight throws preflight-failed when not ok', async () => {
  const fetchImpl = async () => { throw new Error('down'); };
  let thrown = null;
  try { await assertPreflight({ baseUrl: 'http://localhost:11434/v1', model: 'qwen', fetchImpl }); }
  catch (e) { thrown = e; }
  assert.equal(thrown && thrown.code, 'preflight-failed');
});

test('PF-6: _isLocal classifies localhost/127.0.0.1 as local, public host as remote', () => {
  assert.equal(_isLocal('http://localhost:11434/v1'), true);
  assert.equal(_isLocal('http://127.0.0.1:11434/v1'), true);
  assert.equal(_isLocal('https://api.openai.com/v1'), false);
});

test('PF-7: HTTP 401 on /models ⇒ not reachable-ok, hint names status', async () => {
  const fetchImpl = async () => _res({ ok: false, status: 401 });
  const r = await preflight({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.hint, /401/);
});
