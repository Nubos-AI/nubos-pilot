'use strict';

const { collectSnapshot, renderSnapshot } = require('../../lib/dashboard.cjs');

function _parseArgs(args) {
  const out = { json: false, noColor: false };
  for (const a of args) {
    if (a === '--json')     out.json = true;
    else if (a === '--no-color') out.noColor = true;
  }
  return out;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);

  const snap = collectSnapshot(cwd);
  if (parsed.json) {
    stdout.write(JSON.stringify(snap, null, 2) + '\n');
    return 0;
  }
  const useColor = !parsed.noColor && Boolean(stdout.isTTY);
  stdout.write(renderSnapshot(snap, { color: useColor }) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
