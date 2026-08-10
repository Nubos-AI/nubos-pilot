'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { thread } = require('../../lib/messaging.cjs');

function _parseArgs(args) {
  const out = { id: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--id') { out.id = args[++i] || null; continue; }
    if (!a.startsWith('--') && !out.id) { out.id = a; continue; }
  }
  return out;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);

  if (!parsed.id) {
    throw new NubosPilotError(
      'messages-missing-id',
      'msg-id required (positional or --id)',
      {},
    );
  }

  const result = thread(parsed.id, cwd);
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
