'use strict';

const { listHandoffs } = require('../../lib/handoff.cjs');

function _parseArgs(args) {
  const out = { for: null, milestone: null, status: null, global: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--for')        { out.for = args[++i] || null; continue; }
    if (a === '--milestone')  { out.milestone = args[++i] || null; continue; }
    if (a === '--status')     { out.status = args[++i] || null; continue; }
    if (a === '--global')     { out.global = true; continue; }
  }
  return out;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);
  const list = listHandoffs(parsed, cwd);
  stdout.write(JSON.stringify(list) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
