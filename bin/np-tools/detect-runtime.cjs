'use strict';

const { detect } = require('../../lib/runtime/index.cjs');

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const result = detect({ cwd });
  if (args.includes('--json')) {
    stdout.write(JSON.stringify(result) + '\n');
  } else {
    stdout.write(result.runtime + '\n');
  }
  return 0;
}

module.exports = { run };

if (require.main === module) {
  const code = run(process.argv.slice(2));
  if (typeof code === 'number' && code !== 0) process.exit(code);
}
