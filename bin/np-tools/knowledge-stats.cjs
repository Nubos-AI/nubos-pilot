'use strict';

const { indexStats, buildIndex, writeIndex } = require('../../lib/knowledge.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  let stats = indexStats(cwd);
  if (!stats.exists) {
    const idx = buildIndex(cwd);
    writeIndex(idx, cwd);
    stats = indexStats(cwd);
  }
  stdout.write(JSON.stringify({ ok: true, stats }));
  return 0;
}

module.exports = { run };
