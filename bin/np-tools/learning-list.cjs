'use strict';

const knowledgeAdapter = require('../../lib/knowledge-adapter.cjs');
const args = require('./_args.cjs');

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const limit = args.getFlag(list, '--limit');
  const cap = limit != null ? Math.max(1, Number(limit)) : 100;

  const adapter = knowledgeAdapter.getAdapter(cwd);
  const all = adapter.list();
  const sorted = all.slice().sort((a, b) => {
    const oc = (b.occurrence || 0) - (a.occurrence || 0);
    if (oc !== 0) return oc;
    return String(b.last_seen || '').localeCompare(String(a.last_seen || ''));
  });
  const truncated = sorted.slice(0, cap);
  const projected = truncated.map((l) => {
    const { tokens, ...rest } = l;
    return rest;
  });
  stdout.write(JSON.stringify({
    adapter: adapter.name,
    total: all.length,
    returned: projected.length,
    learnings: projected,
  }) + '\n');
  return projected;
}

module.exports = { run };
