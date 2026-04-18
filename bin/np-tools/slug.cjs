const { phaseSlug } = require('../../lib/phase.cjs');

const MAX_SLUG_LENGTH = 128;

function _usage() {
  return 'Usage:\n  np-tools.cjs generate-slug "<text>" [--raw]';
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length === 0) {
    stderr.write(_usage() + '\n');
    return 1;
  }
  const raw = args.includes('--raw');
  const text = args.find((a) => !String(a).startsWith('--'));
  if (text == null || String(text).length === 0) {
    stderr.write(_usage() + '\n');
    return 1;
  }
  const slug = phaseSlug(String(text)).slice(0, MAX_SLUG_LENGTH);
  if (raw) stdout.write(slug);
  else stdout.write(slug + '\n');
  return 0;
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
