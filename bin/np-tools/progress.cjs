const { readProgress } = require('../../lib/progress.cjs');

function run(_args, cwd) {
  return readProgress(cwd || process.cwd());
}

module.exports = { run };
