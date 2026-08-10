'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { search } = require('../../lib/knowledge.cjs');

function _parseArgs(args) {
  const out = { query: null, limit: 10, task: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit' || a === '-n') { out.limit = parseInt(args[++i], 10) || 10; continue; }
    if (a === '--query' || a === '-q') { out.query = args[++i] || null; continue; }
    if (a === '--task' || a === '-t') { out.task = args[++i] || null; continue; }
    if (a === '--agent') { out.agent = args[++i] || null; continue; }
    positional.push(a);
  }
  if (out.query == null) out.query = positional.join(' ').trim() || null;
  return out;
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const parsed = _parseArgs(args || []);
  if (!parsed.query) {
    throw new NubosPilotError(
      'knowledge-search-missing-query',
      'knowledge-search requires a query (positional or --query)',
      { args },
    );
  }
  const result = search(parsed.query, cwd, { limit: parsed.limit });
  stdout.write(JSON.stringify(result));
  if (parsed.task) {
    try {
      require('../../lib/nubosloop.cjs')
        .recordSearchEvidence(parsed.task, parsed.query, cwd, parsed.agent);
    } catch { /* best-effort: evidence ledger is non-fatal */ }
  }
  return 0;
}

module.exports = { run, _parseArgs };
