const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchRouting, resolveProvider, VALID_PROVIDER_KINDS, DEFAULT_PROVIDER } = require('./model-providers.cjs');

test('MPV-1: exact routing key beats glob', () => {
  const r = { 'np-critic': { provider: 'a' }, 'np-critic*': { provider: 'b' } };
  assert.equal(matchRouting('np-critic', r).match, 'exact');
  assert.equal(matchRouting('np-critic', r).entry.provider, 'a');
});

test('MPV-2: trailing-* glob matches by prefix, longest prefix wins', () => {
  const r = { 'np-*': { provider: 'wide' }, 'np-critic*': { provider: 'narrow' } };
  assert.equal(matchRouting('np-critic-style', r).entry.provider, 'narrow');
  assert.equal(matchRouting('np-planner', r).entry.provider, 'wide');
});

test('MPV-3: no match returns null; empty agentName returns null', () => {
  assert.equal(matchRouting('np-x', { 'np-y*': {} }), null);
  assert.equal(matchRouting(null, { 'np-y*': {} }), null);
  assert.equal(matchRouting('np-x', null), null);
});

test('MPV-4: absent config resolves to implicit claude-native default', () => {
  const out = resolveProvider({ agentName: 'np-planner', tier: 'opus', config: {} });
  assert.deepEqual(
    { provider: out.provider, kind: out.kind, model: out.model, routed: out.routed },
    { provider: DEFAULT_PROVIDER, kind: 'native', model: null, routed: false },
  );
});

test('MPV-5: openai-compat resolves models[tier] when unpinned', () => {
  const config = {
    model_providers: { ollama: { kind: 'openai-compat', base_url: 'http://x/v1', models: { sonnet: 'm-s', opus: 'm-o' } } },
    agent_routing: { 'np-executor': { provider: 'ollama' } },
  };
  assert.equal(resolveProvider({ agentName: 'np-executor', tier: 'sonnet', config }).model, 'm-s');
  assert.equal(resolveProvider({ agentName: 'np-executor', tier: 'opus', config }).model, 'm-o');
});

test('MPV-6: undefined provider reference throws provider-undefined', () => {
  let thrown = null;
  try {
    resolveProvider({
      agentName: 'np-executor', tier: 'opus',
      config: { model_providers: { claude: { kind: 'native' } }, agent_routing: { 'np-executor': { provider: 'ghost' } } },
    });
  } catch (e) { thrown = e; }
  assert.equal(thrown && thrown.code, 'provider-undefined');
});

test('MPV-7: invalid kind throws provider-invalid-kind', () => {
  let thrown = null;
  try {
    resolveProvider({
      agentName: 'np-executor', tier: 'opus',
      config: { model_providers: { weird: { kind: 'grpc' } }, agent_routing: { 'np-executor': { provider: 'weird' } } },
    });
  } catch (e) { thrown = e; }
  assert.equal(thrown && thrown.code, 'provider-invalid-kind');
});

test('MPV-8: routing entry without provider throws agent-routing-missing-provider', () => {
  let thrown = null;
  try {
    resolveProvider({ agentName: 'np-executor', tier: 'opus', config: { agent_routing: { 'np-executor': { model: 'x' } } } });
  } catch (e) { thrown = e; }
  assert.equal(thrown && thrown.code, 'agent-routing-missing-provider');
});

test('MPV-9: baseUrl + apiKeyEnv surfaced for openai-compat', () => {
  const out = resolveProvider({
    agentName: 'np-executor', tier: 'opus',
    config: {
      model_providers: { openai: { kind: 'openai-compat', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', models: { opus: 'gpt-4.1' } } },
      agent_routing: { 'np-executor': { provider: 'openai' } },
    },
  });
  assert.equal(out.baseUrl, 'https://api.openai.com/v1');
  assert.equal(out.apiKeyEnv, 'OPENAI_API_KEY');
});

test('MPV-10: VALID_PROVIDER_KINDS is the closed set [native, openai-compat]', () => {
  assert.deepEqual(VALID_PROVIDER_KINDS, ['native', 'openai-compat']);
});
