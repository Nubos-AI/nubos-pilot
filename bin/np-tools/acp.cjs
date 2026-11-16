'use strict';

// CLI surface for the ACP groundwork (ADR-0030).
//
// Read-only and diagnostic. There is deliberately no verb that connects to an
// agent: no transport is wired yet, and a verb that looked like it connected
// would be the most misleading thing this module could ship.

const acp = require('../../lib/acp.cjs');
const { getFlag, emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs acp status [--json]',
    '  np-tools.cjs acp initialize-request [--version <n>] [--json]',
    '  np-tools.cjs acp negotiate --result <json>',
    '',
    'Agent Client Protocol (JSON-RPC 2.0) groundwork. nubos-pilot maintains a',
    'per-runtime payload for fourteen host CLIs, and each new host is another',
    'adapter; ACP standardises exactly that boundary, so if it holds, one adapter',
    'eventually replaces N.',
    '',
    'Stage: groundwork. The protocol vocabulary, newline-delimited framing and the',
    'initialize handshake are implemented and tested. No transport is wired into the',
    'spawn path, and every client capability is off — declaring one before its',
    'handler exists would make the agent wait on a reply that never comes.',
    '',
    'There is no verb that connects to an agent, on purpose: a verb that looked like',
    'it connected would be the most misleading thing here.',
  ].join('\n');
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    stdout.write(_usage() + '\n');
    return args.length === 0 ? 1 : 0;
  }

  const verb = args[0];
  const rest = args.slice(1);
  const asJson = rest.includes('--json');

  try {
    switch (verb) {
      case 'status': {
        const s = acp.status();
        if (asJson) {
          stdout.write(JSON.stringify(s, null, 2) + '\n');
          return 0;
        }
        stdout.write('stage: ' + s.stage + '\n');
        stdout.write('protocol versions: ' + s.supported_protocol_versions.join(', ') + '\n');
        stdout.write('transport wired: ' + s.transport_wired + '\n');
        stdout.write('implemented client methods: '
          + (s.implemented_client_methods.length ? s.implemented_client_methods.join(', ') : '(none)') + '\n');
        stdout.write('\n' + s.summary + '\n');
        return 0;
      }

      case 'initialize-request': {
        const raw = getFlag(rest, '--version');
        const req = acp.buildInitializeRequest(
          raw === undefined ? {} : { version: Number(raw) },
        );
        stdout.write(JSON.stringify(req, null, asJson ? 2 : 0) + '\n');
        return 0;
      }

      case 'negotiate': {
        const raw = getFlag(rest, '--result');
        if (!raw) {
          stderr.write(JSON.stringify({
            code: 'acp-missing-result',
            message: '--result <json> is required (the initialize response `result` object)',
            details: {},
          }) + '\n');
          return 1;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          stderr.write(JSON.stringify({
            code: 'acp-result-invalid-json',
            message: '--result must be valid JSON',
            details: { cause: err && err.message },
          }) + '\n');
          return 1;
        }
        stdout.write(JSON.stringify(acp.negotiate(parsed), null, 2) + '\n');
        return 0;
      }

      default: {
        stderr.write(JSON.stringify({
          code: 'acp-unknown-verb',
          message: 'Unknown verb: ' + verb,
          details: { verb, allowed: ['status', 'initialize-request', 'negotiate'] },
        }) + '\n');
        return 1;
      }
    }
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'acp-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
