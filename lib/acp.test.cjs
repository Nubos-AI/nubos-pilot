'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const acp = require('./acp.cjs');

function _code(code) {
  return (err) => err && err.name === 'NubosPilotError' && err.code === code;
}

// ------------------------------------------------------------- initialize

test('ACP-1: the initialize request matches the spec envelope', () => {
  const req = acp.buildInitializeRequest();
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'initialize');
  assert.equal(req.params.protocolVersion, acp.PREFERRED_PROTOCOL_VERSION);
  assert.ok(Number.isInteger(req.params.protocolVersion), 'the spec makes this a single integer');
  assert.equal(req.params.clientInfo.name, 'nubos-pilot');
  assert.ok(req.params.clientCapabilities);
});

test('ACP-2: we never advertise a version this build does not implement', () => {
  assert.throws(() => acp.buildInitializeRequest({ version: 99 }), _code('acp-unsupported-request-version'));
  assert.throws(() => acp.buildInitializeRequest({ version: '1' }), _code('acp-unsupported-request-version'));
});

test('ACP-3: clientInfo can be extended but the name stays ours unless overridden', () => {
  const req = acp.buildInitializeRequest({ clientInfo: { version: '1.5.0' } });
  assert.equal(req.params.clientInfo.name, 'nubos-pilot');
  assert.equal(req.params.clientInfo.version, '1.5.0');
});

// -------------------------------------------------------------- negotiate

test('ACP-4: a matching version negotiates cleanly', () => {
  const res = acp.negotiate({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      mcpCapabilities: { http: true },
    },
    agentInfo: { name: 'some-agent', version: '2.0.0' },
    authMethods: [],
  });
  assert.equal(res.protocol_version, 1);
  assert.equal(res.supports_load_session, true);
  assert.deepEqual(res.prompt_capabilities, { image: true });
  assert.equal(res.requires_authentication, false);
  assert.equal(res.agent_info.name, 'some-agent');
});

test('ACP-5: an unsupported negotiated version refuses rather than continuing', () => {
  // A differing MAJOR means the message shapes differ, so proceeding would send
  // well-formed requests that mean something else — a silent behavioural bug
  // instead of a handshake error.
  try {
    acp.negotiate({ protocolVersion: 2 });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.equal(err.code, 'acp-version-unsupported');
    assert.match(err.message, /mean something else/);
  }
});

test('ACP-6: a non-integer protocolVersion is a protocol mismatch, not something to coerce', () => {
  assert.throws(() => acp.negotiate({ protocolVersion: '1' }), _code('acp-initialize-bad-version'));
  assert.throws(() => acp.negotiate({ protocolVersion: 1.5 }), _code('acp-initialize-bad-version'));
  assert.throws(() => acp.negotiate({}), _code('acp-initialize-bad-version'));
});

test('ACP-7: a non-object result is refused', () => {
  for (const bad of [null, undefined, 'ok', 42, []]) {
    assert.throws(() => acp.negotiate(bad), _code('acp-initialize-bad-result'));
  }
});

test('ACP-8: an unstated agent capability is treated as absent, never as available', () => {
  const res = acp.negotiate({ protocolVersion: 1 });
  assert.equal(res.supports_load_session, false);
  assert.deepEqual(res.prompt_capabilities, {});
  assert.deepEqual(res.mcp_capabilities, {});
  assert.equal(res.requires_authentication, false);
});

test('ACP-9: declared auth methods mark the session as needing authentication', () => {
  const res = acp.negotiate({ protocolVersion: 1, authMethods: [{ id: 'oauth' }] });
  assert.equal(res.requires_authentication, true);
  assert.equal(res.auth_methods.length, 1);
});

// ---------------------------------------------------------------- framing

test('ACP-10: encoding produces exactly one newline-terminated line', () => {
  const line = acp.encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.ok(line.endsWith('\n'));
  assert.equal(line.split('\n').length, 2, 'one message, one delimiter');
});

test('ACP-11: a newline inside a string value is escaped, not emitted raw', () => {
  const line = acp.encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x', params: { text: 'a\nb' } });
  assert.equal(line.split('\n').length, 2, 'a raw newline would split one message into two broken halves');
  assert.deepEqual(JSON.parse(line).params.text, 'a\nb');
});

test('ACP-12: encoding a non-object is refused', () => {
  assert.throws(() => acp.encodeMessage('already serialised'), _code('acp-encode-not-object'));
  assert.throws(() => acp.encodeMessage(null), _code('acp-encode-not-object'));
});

test('ACP-13: decoding splits complete messages and returns the remainder', () => {
  const a = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
  const b = JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} });
  const out = acp.decodeChunk('', a + '\n' + b + '\n');
  assert.equal(out.messages.length, 2);
  assert.equal(out.remainder, '');
});

test('ACP-14: a message split across chunks is reassembled, not dropped', () => {
  // A chunk boundary lands mid-message routinely; a decoder that assumed
  // chunk == message would corrupt traffic under exactly the load that makes it
  // hard to reproduce.
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
  const mid = Math.floor(msg.length / 2);
  const first = acp.decodeChunk('', msg.slice(0, mid));
  assert.equal(first.messages.length, 0);
  assert.equal(first.remainder, msg.slice(0, mid));
  const second = acp.decodeChunk(first.remainder, msg.slice(mid) + '\n');
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].id, 7);
  assert.equal(second.remainder, '');
});

test('ACP-15: a malformed line is collected as an error without discarding its neighbours', () => {
  const good = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
  const out = acp.decodeChunk('', good + '\n{ broken\n' + good + '\n');
  assert.equal(out.messages.length, 2);
  assert.equal(out.errors.length, 1);
});

test('ACP-16: blank lines between messages are ignored', () => {
  const good = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
  const out = acp.decodeChunk('', '\n\n' + good + '\n\n');
  assert.equal(out.messages.length, 1);
  assert.equal(out.errors.length, 0);
});

test('ACP-17: decodeChunk tolerates null inputs', () => {
  const out = acp.decodeChunk(null, null);
  assert.deepEqual(out.messages, []);
  assert.equal(out.remainder, '');
});

// -------------------------------------------------------------- classify

test('ACP-18: the four JSON-RPC shapes are told apart', () => {
  // Conflating them hangs the other side: a notification answered with a result,
  // or a response routed as a request.
  assert.deepEqual(
    acp.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    { kind: 'request', method: 'initialize', id: 1 },
  );
  assert.deepEqual(
    acp.classifyMessage({ jsonrpc: '2.0', method: 'session/cancel' }),
    { kind: 'notification', method: 'session/cancel' },
  );
  assert.equal(acp.classifyMessage({ jsonrpc: '2.0', id: 1, result: {} }).kind, 'response');
  assert.equal(acp.classifyMessage({ jsonrpc: '2.0', id: 1, error: { code: -1 } }).kind, 'error');
});

test('ACP-19: a wrong or missing jsonrpc version is invalid', () => {
  assert.equal(acp.classifyMessage({ jsonrpc: '1.0', id: 1, result: {} }).kind, 'invalid');
  assert.equal(acp.classifyMessage({ id: 1, result: {} }).kind, 'invalid');
  assert.equal(acp.classifyMessage(null).kind, 'invalid');
});

test('ACP-20: a message with neither method nor result is invalid', () => {
  assert.equal(acp.classifyMessage({ jsonrpc: '2.0', id: 1 }).kind, 'invalid');
});

test('ACP-21: a null id makes a method call a notification, per JSON-RPC', () => {
  assert.equal(acp.classifyMessage({ jsonrpc: '2.0', id: null, method: 'x' }).kind, 'notification');
});

// ------------------------------------------------------------- buildCall

test('ACP-22: a request carries an id and a notification must not', () => {
  const req = acp.buildCall(acp.AGENT_METHODS.SESSION_PROMPT, { sessionId: 's1' }, 3);
  assert.equal(req.id, 3);
  const note = acp.buildCall(acp.AGENT_METHODS.SESSION_CANCEL, { sessionId: 's1' });
  assert.equal('id' in note, false, 'a notification with an id would leave a caller awaiting forever');
});

test('ACP-23: a request without an id is refused', () => {
  assert.throws(
    () => acp.buildCall(acp.AGENT_METHODS.SESSION_PROMPT, {}),
    _code('acp-request-needs-id'),
  );
});

test('ACP-24: giving a notification an id is refused', () => {
  assert.throws(
    () => acp.buildCall(acp.AGENT_METHODS.SESSION_CANCEL, {}, 4),
    _code('acp-notification-with-id'),
  );
});

test('ACP-25: session/cancel is the notification the spec defines it as', () => {
  assert.deepEqual(acp.NOTIFICATIONS, ['session/cancel']);
});

test('ACP-26: a missing method name is refused', () => {
  assert.throws(() => acp.buildCall('', {}, 1), _code('acp-bad-method'));
  assert.throws(() => acp.buildCall(undefined, {}, 1), _code('acp-bad-method'));
});

test('ACP-27: params are omitted when not supplied rather than sent as null', () => {
  const req = acp.buildCall(acp.AGENT_METHODS.SESSION_NEW, undefined, 1);
  assert.equal('params' in req, false);
});

// ----------------------------------------------------------- capabilities

test('ACP-28: every client capability is off, because no handler exists yet', () => {
  // A declared capability is a promise the peer acts on. Declaring
  // fs.readTextFile without the handler makes the agent send a request that never
  // gets answered — a hang, at the least debuggable moment.
  assert.equal(acp.CLIENT_CAPABILITIES.fs.readTextFile, false);
  assert.equal(acp.CLIENT_CAPABILITIES.fs.writeTextFile, false);
  assert.equal(acp.CLIENT_CAPABILITIES.terminal, false);
});

test('ACP-29: every capability flag maps to a real client method', () => {
  // Parity gate: a future implementer flips the flag and adds the handler
  // together, and omitting either side fails here.
  const methods = new Set(Object.values(acp.CLIENT_METHODS));
  for (const [flag, method] of Object.entries(acp.CAPABILITY_METHODS)) {
    assert.ok(methods.has(method), 'capability ' + flag + ' maps to unknown method ' + method);
    assert.equal(typeof acp._capabilityEnabled(flag), 'boolean');
  }
});

test('ACP-30: status reports the groundwork stage honestly', () => {
  const s = acp.status();
  assert.equal(s.stage, 'groundwork');
  assert.equal(s.transport_wired, false);
  assert.deepEqual(s.implemented_client_methods, [], 'nothing is implemented, so nothing is claimed');
  assert.match(s.summary, /No transport is wired/);
  assert.deepEqual(s.supported_protocol_versions, [1]);
});

test('ACP-31: _capabilityEnabled reads nested flags and refuses to invent them', () => {
  assert.equal(acp._capabilityEnabled('fs.readTextFile'), false);
  assert.equal(acp._capabilityEnabled('terminal'), false);
  assert.equal(acp._capabilityEnabled('nope.nothere'), false);
});

test('ACP-32: the method vocabulary uses the exact spec names', () => {
  // These strings go on the wire; a typo is a method-not-found at runtime.
  assert.equal(acp.AGENT_METHODS.SESSION_NEW, 'session/new');
  assert.equal(acp.AGENT_METHODS.SESSION_PROMPT, 'session/prompt');
  assert.equal(acp.AGENT_METHODS.SESSION_LOAD, 'session/load');
  assert.equal(acp.AGENT_METHODS.SESSION_SET_MODE, 'session/set_mode');
  assert.equal(acp.CLIENT_METHODS.FS_READ_TEXT_FILE, 'fs/read_text_file');
  assert.equal(acp.CLIENT_METHODS.SESSION_REQUEST_PERMISSION, 'session/request_permission');
  assert.equal(acp.CLIENT_METHODS.ELICITATION_CREATE, 'elicitation/create');
});

test('ACP-33: a full handshake round-trips through the framing', () => {
  const req = acp.buildInitializeRequest({ id: 0 });
  const wire = acp.encodeMessage(req);
  const decoded = acp.decodeChunk('', wire);
  assert.equal(decoded.messages.length, 1);
  assert.equal(acp.classifyMessage(decoded.messages[0]).kind, 'request');

  const responseWire = acp.encodeMessage({
    jsonrpc: '2.0', id: 0,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
  });
  const back = acp.decodeChunk('', responseWire);
  assert.equal(acp.classifyMessage(back.messages[0]).kind, 'response');
  assert.equal(acp.negotiate(back.messages[0].result).protocol_version, 1);
});

test('ACP-21: a chunk boundary inside a multi-byte character does not corrupt the message', () => {
  // The failure this pins is silent: String(buffer) per chunk turns the split
  // character into two U+FFFD, and the line still parses as valid JSON — a
  // corrupted payload that reports no error at any layer.
  const message = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { text: 'Grüße — 🎯' } };
  const wire = Buffer.from(acp.encodeMessage(message), 'utf-8');

  const decoder = acp.createDecoder();
  const got = [];
  const errs = [];
  for (let i = 0; i < wire.length; i += 3) {
    const res = decoder.push(wire.subarray(i, i + 3));
    got.push(...res.messages);
    errs.push(...res.errors);
  }

  assert.deepEqual(errs, []);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], message);
  assert.equal(decoder.remainder(), '');
});

test('ACP-22: decodeChunk refuses bytes rather than decoding them per chunk', () => {
  const wire = Buffer.from(acp.encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' }), 'utf-8');
  assert.throws(() => acp.decodeChunk('', wire), (err) => err.code === 'acp-decode-binary-chunk');
  assert.throws(() => acp.decodeChunk(wire, ''), (err) => err.code === 'acp-decode-binary-chunk');
  // The string path is the one every existing caller uses and must not change.
  assert.equal(acp.decodeChunk('', wire.toString('utf-8')).messages.length, 1);
});

test('ACP-23: a decoder instance carries state per stream, not globally', () => {
  const a = acp.createDecoder();
  const b = acp.createDecoder();
  a.push('{"jsonrpc":"2.0","id":1,');
  assert.deepEqual(b.push('{"jsonrpc":"2.0","id":2,"method":"x"}\n').messages,
    [{ jsonrpc: '2.0', id: 2, method: 'x' }]);
  assert.deepEqual(a.push('"method":"y"}\n').messages, [{ jsonrpc: '2.0', id: 1, method: 'y' }]);
});
