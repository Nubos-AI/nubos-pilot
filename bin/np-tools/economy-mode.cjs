'use strict';

const { economyFlags } = require('../../lib/economy-mode.cjs');
const { emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return 'Usage:\n  np-tools.cjs economy-mode [--json]';
}

function _readConfig(cwd) {
  const { readConfig } = require('../../lib/config.cjs');
  try {
    const cfg = readConfig(cwd);
    return cfg && Object.keys(cfg).length === 0 ? null : cfg;
  } catch (err) {
    if (err && err.code === 'not-in-project') return null;
    throw err;
  }
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write(_usage() + '\n');
    return 0;
  }
  const asJson = args.includes('--json');
  try {
    const config = _readConfig(cwd);
    const flags = economyFlags(config || {});
    stdout.write((asJson ? JSON.stringify(flags) : flags.mode) + '\n');
    return 0;
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'economy-mode-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
