'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const handler = require('./acp.cjs');

function _ctx() {
  const out = [];
  const err = [];
  return {
    ctx: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

test('ACPH-1: no args prints usage non-zero; --help exits zero', () => {
  const a = _ctx();
  assert.equal(handler.run([], a.ctx), 1);
  assert.match(a.out(), /Usage:/);
  const b = _ctx();
  assert.equal(handler.run(['--help'], b.ctx), 0);
  assert.match(b.out(), /groundwork/);
});

test('ACPH-2: status reports the stage without overclaiming', () => {
  const c = _ctx();
  assert.equal(handler.run(['status'], c.ctx), 0);
  assert.match(c.out(), /stage: groundwork/);
  assert.match(c.out(), /transport wired: false/);
  assert.match(c.out(), /implemented client methods: \(none\)/);
});

test('ACPH-3: status --json exposes the capability declaration', () => {
  const c = _ctx();
  assert.equal(handler.run(['status', '--json'], c.ctx), 0);
  const s = JSON.parse(c.out());
  assert.equal(s.transport_wired, false);
  assert.equal(s.client_capabilities.fs.readTextFile, false);
  assert.deepEqual(s.implemented_client_methods, []);
});

test('ACPH-4: initialize-request emits a valid JSON-RPC envelope', () => {
  const c = _ctx();
  assert.equal(handler.run(['initialize-request'], c.ctx), 0);
  const req = JSON.parse(c.out());
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'initialize');
  assert.equal(req.params.protocolVersion, 1);
});

test('ACPH-5: an unsupported --version is refused rather than advertised', () => {
  const c = _ctx();
  assert.equal(handler.run(['initialize-request', '--version', '99'], c.ctx), 1);
  assert.match(c.err(), /acp-unsupported-request-version/);
});

test('ACPH-6: negotiate accepts a matching result', () => {
  const c = _ctx();
  assert.equal(handler.run(['negotiate', '--result',
    JSON.stringify({ protocolVersion: 1, agentCapabilities: { loadSession: true } })], c.ctx), 0);
  const res = JSON.parse(c.out());
  assert.equal(res.protocol_version, 1);
  assert.equal(res.supports_load_session, true);
});

test('ACPH-7: negotiate refuses an unsupported protocol version', () => {
  const c = _ctx();
  assert.equal(handler.run(['negotiate', '--result', JSON.stringify({ protocolVersion: 2 })], c.ctx), 1);
  assert.match(c.err(), /acp-version-unsupported/);
});

test('ACPH-8: negotiate requires a result and rejects malformed JSON', () => {
  const missing = _ctx();
  assert.equal(handler.run(['negotiate'], missing.ctx), 1);
  assert.match(missing.err(), /acp-missing-result/);

  const broken = _ctx();
  assert.equal(handler.run(['negotiate', '--result', '{ nope'], broken.ctx), 1);
  assert.match(broken.err(), /acp-result-invalid-json/);
});

test('ACPH-9: there is no verb that connects to an agent', () => {
  // A verb that looked like it connected would be the most misleading thing this
  // module could ship while no transport exists.
  for (const verb of ['connect', 'prompt', 'session', 'run', 'spawn']) {
    const c = _ctx();
    assert.equal(handler.run([verb], c.ctx), 1);
    assert.match(c.err(), /acp-unknown-verb/);
  }
});

test('ACPH-10: an unknown verb lists the allowed set', () => {
  const c = _ctx();
  assert.equal(handler.run(['frobnicate'], c.ctx), 1);
  assert.match(c.err(), /initialize-request/);
});
