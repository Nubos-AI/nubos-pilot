'use strict';

const { resolveTextModeDetail } = require('../../lib/text-mode.cjs');

function _usage() {
  return 'Usage:\n  np-tools.cjs text-mode [--json]';
}

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'text-mode-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];

  let wantJson = false;
  for (const a of args) {
    if (a === '--json') { wantJson = true; continue; }
    if (a === '-h' || a === '--help') {
      stdout.write(_usage() + '\n');
      return 0;
    }
    stderr.write(JSON.stringify({
      code: 'text-mode-unknown-arg',
      message: 'Unknown argument: ' + a,
      details: { arg: a },
    }) + '\n');
    return 1;
  }

  try {
    const detail = resolveTextModeDetail(cwd);
    if (wantJson) {
      stdout.write(JSON.stringify(detail) + '\n');
    } else {
      stdout.write(String(detail.enabled) + '\n');
    }
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
