'use strict';

const { inbox } = require('../../lib/messaging.cjs');

function _parseArgs(args) {
  const out = { agent: null, kind: null, since: null, phase: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent') { out.agent = args[++i] || null; continue; }
    if (a === '--kind')  { out.kind = args[++i] || null; continue; }
    if (a === '--since') { out.since = args[++i] || null; continue; }
    if (a === '--phase') { out.phase = args[++i] || null; continue; }
    if (a === '--task')  { out.phase = args[++i] || null; continue; }
  }
  return out;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);

  const result = inbox(parsed.agent, {
    kind: parsed.kind || undefined,
    since: parsed.since || undefined,
    phase: parsed.phase || undefined,
  }, cwd);

  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
