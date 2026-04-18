const { NubosPilotError } = require('../../lib/core.cjs');
const { parseRoadmap } = require('../../lib/roadmap.cjs');

function _usage() {
  return 'Usage:\n  np-tools.cjs phase next-decimal <base> [--raw]';
}

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'phase-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function nextDecimal(base, cwd) {
  if (!/^[0-9]+$/.test(String(base))) {
    throw new NubosPilotError('phase-invalid-base', 'phase next-decimal base must be a non-negative integer: ' + base, { base });
  }
  const baseStr = String(base);
  let phases;
  try {
    phases = parseRoadmap(cwd || process.cwd()).phases;
  } catch (err) {
    if (err && err.code === 'roadmap-parse-error') return baseStr + '.1';
    throw err;
  }
  const prefix = baseStr + '.';
  let max = 0;
  for (const ph of phases) {
    const n = String(ph.number);
    if (n.startsWith(prefix)) {
      const suf = Number(n.slice(prefix.length));
      if (Number.isInteger(suf) && suf > max) max = suf;
    }
  }
  return baseStr + '.' + (max + 1);
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const sub = args.shift();
  if (sub !== 'next-decimal') {
    stderr.write(_usage() + '\n');
    return 1;
  }
  const raw = args.includes('--raw');
  const base = args.find((a) => !String(a).startsWith('--'));
  if (base == null) {
    stderr.write(_usage() + '\n');
    return 1;
  }
  try {
    const result = nextDecimal(base, cwd);
    if (raw) stdout.write(result);
    else stdout.write(result + '\n');
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, nextDecimal };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
