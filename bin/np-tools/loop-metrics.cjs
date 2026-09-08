'use strict';

const nubosloop = require('../../lib/nubosloop.cjs');

function run(_args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const metrics = nubosloop.aggregateLoopMetrics(cwd);
  stdout.write(JSON.stringify(metrics) + '\n');
  return metrics;
}

module.exports = { run };
