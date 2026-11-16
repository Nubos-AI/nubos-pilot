'use strict';

const { buildIndex, writeIndex, indexStats } = require('../../lib/knowledge.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const idx = buildIndex(cwd);
  const dest = writeIndex(idx, cwd);
  const stats = indexStats(cwd);
  stdout.write(JSON.stringify({
    ok: true,
    index_path: dest,
    built_at: idx.built_at,
    total_files: idx.total_files,
    total_chunks: idx.total_chunks,
    unique_terms: stats.exists ? stats.unique_terms : 0,
  }));
  return 0;
}

module.exports = { run };
