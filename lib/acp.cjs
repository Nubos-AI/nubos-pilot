'use strict';

// Agent Client Protocol groundwork (ADR-0030).
//
// Why this exists at all: nubos-pilot maintains a per-runtime payload for
// fourteen host CLIs. Each new host is another adapter, another install path,
// another set of doctor checks. ACP is a JSON-RPC 2.0 protocol for exactly the
// boundary those adapters keep re-implementing, so if it holds, one adapter
// eventually replaces N.
//
// What this deliberately is NOT: a working ACP client. Wiring ACP into the spawn
// path is a large change with a real risk of building against a protocol that
// still moves, and speculative plumbing is what ADR-0002's economy axis exists to
// prevent. What is built here is the part that is useful before any transport
// exists and that a future client must get right anyway:
//
//   * the protocol vocabulary as data, so the method names live in one place
//   * newline-delimited JSON-RPC framing, encode and decode
//   * the initialize handshake: build the request, validate the response
//   * version negotiation that refuses rather than guesses
//   * an honest capability declaration
//
// The direction matters and is easy to get backwards. In ACP terms the editor is
// the *client* and the coding agent is the *agent*. nubos-pilot installs a
// methodology payload into a host, so in that role it is neither. But since
// ADR-0021 it also runs its own agent loop and spawns agents itself — and in
// *that* role it is a client. So this models nubos-pilot as an ACP client that
// could drive any ACP-compatible agent, which is the role where one adapter
// replaces the per-host spawn integrations.
//
// The capability rule below is the one thing here that is not merely mechanical:
// a declared capability is a promise the peer will act on. Declaring
// `fs.readTextFile: true` without implementing the handler makes the agent send a
// request that never gets answered — a hang, at the least debuggable moment. So
// every capability defaults to false and is turned on only by the code that
// implements it.

const { StringDecoder } = require('string_decoder');
const { NubosPilotError } = require('./core.cjs');

// The MAJOR protocol version this module understands. A single integer per the
// spec. Listed as a set rather than a number because supporting two adjacent
// majors during a transition is normal, and a single constant would force a hard
// cutover.
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1]);

const PREFERRED_PROTOCOL_VERSION = 1;

const JSONRPC_VERSION = '2.0';

// Agent-side methods (we call these).
const AGENT_METHODS = Object.freeze({
  INITIALIZE: 'initialize',
  AUTHENTICATE: 'authenticate',
  SESSION_NEW: 'session/new',
  SESSION_PROMPT: 'session/prompt',
  SESSION_LOAD: 'session/load',
  SESSION_SET_MODE: 'session/set_mode',
  SESSION_CANCEL: 'session/cancel',
});

// Client-side methods (the agent calls these on us). Enumerated even though none
// is implemented yet, because the capability declaration below has to correspond
// to this list one-for-one — that correspondence is what a test can check.
const CLIENT_METHODS = Object.freeze({
  SESSION_REQUEST_PERMISSION: 'session/request_permission',
  FS_READ_TEXT_FILE: 'fs/read_text_file',
  FS_WRITE_TEXT_FILE: 'fs/write_text_file',
  TERMINAL_CREATE: 'terminal/create',
  TERMINAL_OUTPUT: 'terminal/output',
  TERMINAL_KILL: 'terminal/kill',
  ELICITATION_CREATE: 'elicitation/create',
});

// `session/cancel` is a notification: it carries no id and expects no reply.
// Sending it as a request would leave a promise pending forever.
const NOTIFICATIONS = Object.freeze([AGENT_METHODS.SESSION_CANCEL]);

// Which client capability flag gates which client method. A future implementer
// flips a flag here and in the handler at the same time; the parity test makes
// omitting either one fail.
const CAPABILITY_METHODS = Object.freeze({
  'fs.readTextFile': CLIENT_METHODS.FS_READ_TEXT_FILE,
  'fs.writeTextFile': CLIENT_METHODS.FS_WRITE_TEXT_FILE,
  terminal: CLIENT_METHODS.TERMINAL_CREATE,
});

// Everything off. Each flag is a promise to answer a request the agent will
// otherwise never get a reply to, so it is enabled by the commit that implements
// the handler and not before.
const CLIENT_CAPABILITIES = Object.freeze({
  fs: Object.freeze({
    readTextFile: false,
    writeTextFile: false,
  }),
  terminal: false,
});

function _err(code, message, details) {
  return new NubosPilotError(code, message, details || {});
}

function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Build the `initialize` request.
 *
 * @param {object} [opts] {version, clientInfo, capabilities}
 */
function buildInitializeRequest(opts) {
  const o = opts || {};
  const version = o.version === undefined ? PREFERRED_PROTOCOL_VERSION : o.version;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw _err(
      'acp-unsupported-request-version',
      'Refusing to advertise protocol version ' + JSON.stringify(version)
      + '; this build understands ' + SUPPORTED_PROTOCOL_VERSIONS.join(', '),
      { version, supported: SUPPORTED_PROTOCOL_VERSIONS },
    );
  }
  return {
    jsonrpc: JSONRPC_VERSION,
    id: o.id === undefined ? 0 : o.id,
    method: AGENT_METHODS.INITIALIZE,
    params: {
      protocolVersion: version,
      clientCapabilities: o.capabilities || CLIENT_CAPABILITIES,
      clientInfo: Object.assign({
        name: 'nubos-pilot',
        title: 'nubos-pilot',
      }, o.clientInfo || {}),
    },
  };
}

/**
 * Validate an `initialize` result and settle on the version actually in use.
 *
 * The negotiation rule is "refuse rather than guess". If the agent answers with a
 * major this build does not implement, there is no safe fallback: a major version
 * exists precisely because the message shapes differ, so proceeding would send
 * well-formed messages that mean something else. Optimistically continuing is how
 * a protocol mismatch turns into a silent behavioural bug instead of an error at
 * the handshake.
 */
function negotiate(result) {
  if (!_isPlainObject(result)) {
    throw _err('acp-initialize-bad-result', 'The initialize result must be an object', { result });
  }
  const version = result.protocolVersion;
  if (!Number.isInteger(version)) {
    // The spec makes this a single integer. A string here means the peer is not
    // speaking the protocol we think it is, which is worth failing on rather than
    // coercing.
    throw _err(
      'acp-initialize-bad-version',
      'protocolVersion must be an integer (got ' + JSON.stringify(version) + ')',
      { version },
    );
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw _err(
      'acp-version-unsupported',
      'The agent negotiated protocol version ' + version + ', which this build does not implement '
      + '(supported: ' + SUPPORTED_PROTOCOL_VERSIONS.join(', ') + '). Refusing rather than continuing: '
      + 'a differing MAJOR means the message shapes differ, so proceeding would send well-formed '
      + 'requests that mean something else.',
      { version, supported: SUPPORTED_PROTOCOL_VERSIONS },
    );
  }

  const agentCapabilities = _isPlainObject(result.agentCapabilities) ? result.agentCapabilities : {};
  return {
    protocol_version: version,
    agent_info: _isPlainObject(result.agentInfo) ? result.agentInfo : null,
    // Absent means false. Treating an unstated capability as available is the
    // same class of bug as over-declaring our own.
    supports_load_session: agentCapabilities.loadSession === true,
    prompt_capabilities: _isPlainObject(agentCapabilities.promptCapabilities)
      ? agentCapabilities.promptCapabilities : {},
    mcp_capabilities: _isPlainObject(agentCapabilities.mcpCapabilities)
      ? agentCapabilities.mcpCapabilities : {},
    auth_methods: Array.isArray(result.authMethods) ? result.authMethods : [],
    requires_authentication: Array.isArray(result.authMethods) && result.authMethods.length > 0,
  };
}

/**
 * Frame a message for the wire: one compact JSON object per line.
 *
 * A newline inside the payload would split one message into two unparseable
 * halves, so this asserts the encoding is single-line rather than trusting
 * JSON.stringify — which does escape newlines in strings, but would not save us
 * from a caller that pre-serialised.
 */
function encodeMessage(message) {
  if (!_isPlainObject(message)) {
    throw _err('acp-encode-not-object', 'A JSON-RPC message must be an object', { message });
  }
  const line = JSON.stringify(message);
  if (line.includes('\n')) {
    throw _err('acp-encode-embedded-newline', 'Encoded message contains a newline; framing would break', {});
  }
  return line + '\n';
}

/**
 * Decode a newline-delimited stream chunk into complete messages plus the
 * remainder.
 *
 * Returning the remainder is the whole point: a chunk boundary lands mid-message
 * routinely, and a decoder that assumed chunk == message would drop or corrupt
 * traffic under exactly the load that makes it hard to reproduce.
 *
 * Takes decoded text only, and refuses bytes. The same boundary that splits a
 * message splits a multi-byte character, and `String(buf)` turns that into two
 * U+FFFD inside otherwise valid JSON — a corrupted payload that parses cleanly
 * and reports no error. Byte streams go through `createDecoder()`, which carries
 * the partial character across chunks.
 */
function decodeChunk(buffer, chunk) {
  for (const [name, value] of [['buffer', buffer], ['chunk', chunk]]) {
    if (value != null && typeof value !== 'string') {
      throw _err(
        'acp-decode-binary-chunk',
        'decodeChunk takes decoded text, and ' + name + ' is not a string. Decoding bytes per chunk '
        + 'corrupts any multi-byte character the chunk boundary splits, silently and without an error. '
        + 'Use createDecoder() for a byte stream.',
        { argument: name, type: typeof value },
      );
    }
  }
  const combined = (buffer == null ? '' : buffer) + (chunk == null ? '' : chunk);
  const parts = combined.split('\n');
  // The final element is either an incomplete message or '' when the chunk ended
  // cleanly on a delimiter.
  const remainder = parts.pop();
  const messages = [];
  const errors = [];
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch (err) {
      // Collected, not thrown: one malformed line must not discard the messages
      // that framed correctly around it.
      errors.push({ line: line.slice(0, 200), cause: err && err.message });
    }
  }
  return { messages, remainder, errors };
}

/**
 * A stateful decoder for a byte stream: feed it whatever a socket hands you, get
 * complete messages back.
 *
 * This holds the two pieces of state a chunk boundary can land inside — a partial
 * UTF-8 character and a partial line — because holding only the second is the bug
 * `decodeChunk` alone invites. One instance per connection; the state is
 * per-stream and sharing it interleaves two peers' messages.
 *
 * @returns {{push: function(*): {messages: object[], errors: object[]}, remainder: function(): string}}
 */
function createDecoder() {
  const utf8 = new StringDecoder('utf8');
  let pending = '';
  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : utf8.write(Buffer.from(chunk || []));
      const res = decodeChunk(pending, text);
      pending = res.remainder;
      return { messages: res.messages, errors: res.errors };
    },
    remainder() {
      return pending;
    },
  };
}

/**
 * Classify an incoming JSON-RPC message. A peer can send four shapes and
 * conflating them is a routing bug: a notification answered with a result, or a
 * response treated as a request, both hang the other side.
 */
function classifyMessage(message) {
  if (!_isPlainObject(message)) return { kind: 'invalid', reason: 'not-an-object' };
  if (message.jsonrpc !== JSONRPC_VERSION) {
    return { kind: 'invalid', reason: 'bad-jsonrpc-version', version: message.jsonrpc };
  }
  const hasId = message.id !== undefined && message.id !== null;
  if (typeof message.method === 'string') {
    return hasId
      ? { kind: 'request', method: message.method, id: message.id }
      : { kind: 'notification', method: message.method };
  }
  if (message.error !== undefined) return { kind: 'error', id: message.id };
  if (message.result !== undefined) return { kind: 'response', id: message.id };
  return { kind: 'invalid', reason: 'neither-method-nor-result' };
}

/**
 * Build a request or, for the methods the spec defines as notifications, a
 * notification. Getting this wrong on `session/cancel` leaves a promise pending
 * for the life of the process.
 */
function buildCall(method, params, id) {
  if (typeof method !== 'string' || !method.trim()) {
    throw _err('acp-bad-method', 'A method name is required', { method });
  }
  const message = { jsonrpc: JSONRPC_VERSION, method };
  if (!NOTIFICATIONS.includes(method)) {
    if (id === undefined || id === null) {
      throw _err(
        'acp-request-needs-id',
        method + ' is a request and requires an id; without one the peer has nothing to answer',
        { method },
      );
    }
    message.id = id;
  } else if (id !== undefined && id !== null) {
    throw _err(
      'acp-notification-with-id',
      method + ' is a notification and must not carry an id — the peer will not reply, so a caller '
      + 'awaiting that id would wait forever',
      { method },
    );
  }
  if (params !== undefined) message.params = params;
  return message;
}

/**
 * The capability report, used by `doctor` and the docs so the honest answer to
 * "does nubos-pilot speak ACP yet" lives in one place.
 */
function status() {
  const implemented = Object.entries(CAPABILITY_METHODS)
    .filter(([flag]) => _capabilityEnabled(flag))
    .map(([, method]) => method);
  return {
    stage: 'groundwork',
    supported_protocol_versions: SUPPORTED_PROTOCOL_VERSIONS.slice(),
    preferred_protocol_version: PREFERRED_PROTOCOL_VERSION,
    client_capabilities: CLIENT_CAPABILITIES,
    implemented_client_methods: implemented,
    transport_wired: false,
    summary: 'Protocol vocabulary, framing and the initialize handshake are implemented and tested. '
      + 'No transport is wired into the spawn path yet, and every client capability is off because '
      + 'none of the client-side handlers exists — declaring one before implementing it would make the '
      + 'agent wait on a reply that never comes.',
  };
}

function _capabilityEnabled(dottedFlag) {
  const segments = dottedFlag.split('.');
  let cur = CLIENT_CAPABILITIES;
  for (const seg of segments) {
    if (!_isPlainObject(cur) || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return cur === true;
}

module.exports = {
  JSONRPC_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_PROTOCOL_VERSION,
  AGENT_METHODS,
  CLIENT_METHODS,
  NOTIFICATIONS,
  CAPABILITY_METHODS,
  CLIENT_CAPABILITIES,
  buildInitializeRequest,
  negotiate,
  encodeMessage,
  decodeChunk,
  createDecoder,
  classifyMessage,
  buildCall,
  status,
  _capabilityEnabled,
};
