const { computeNextStep } = require('../../lib/next.cjs');

function run(_args, cwd) {
  return computeNextStep(cwd || process.cwd());
}

module.exports = { run };
