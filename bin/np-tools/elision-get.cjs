'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const elision = require('../../lib/elision.cjs');

function _parseArgs(args) {
  const out = { hash: null, json: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--hash') { out.hash = args[++i] || null; continue; }
    if (a === '--json') { out.json = true; continue; }
    positional.push(a);
  }
  if (out.hash == null) out.hash = positional.join('').trim() || null;
  return out;
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const parsed = _parseArgs(args || []);
  if (!parsed.hash) {
    throw new NubosPilotError(
      'elision-get-missing-hash',
      'elision-get requires a hash (positional or --hash)',
      { hint: 'hash is the 12-char id from a ⟦elided:…⟧ marker' },
    );
  }
  const result = elision.retrieve(parsed.hash, cwd);
  if (parsed.json) {
    stdout.write(JSON.stringify(result));
    return result.status === 'ok' ? 0 : 1;
  }
  if (result.status === 'ok') {
    stdout.write(result.original);
    return 0;
  }
  if (result.status === 'expired') {
    stdout.write('[elision ' + parsed.hash + ' expired — original no longer cached (ttl elapsed)]\n');
    return 1;
  }
  stdout.write('[elision ' + parsed.hash + ' not found]\n');
  return 1;
}

module.exports = { run, _parseArgs };
