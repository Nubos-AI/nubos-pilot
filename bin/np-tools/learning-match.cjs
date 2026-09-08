'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const knowledgeAdapter = require('../../lib/knowledge-adapter.cjs');
const args = require('./_args.cjs');

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const query = args.getFlag(list, '--query');
  if (!query) {
    throw new NubosPilotError(
      'learning-match-missing-query',
      'learning-match requires --query "<text>"',
      { hint: 'example: learning-match --query "use jose for jwt" --threshold 0.5 --min-occurrence 3' },
    );
  }
  const opts = {};
  const t = args.getFlag(list, '--threshold');
  if (t !== undefined) opts.threshold = Number(t);
  const m = args.getFlag(list, '--min-occurrence');
  if (m !== undefined) opts.minOccurrence = Number(m);
  const c = args.getFlag(list, '--min-confidence');
  if (c !== undefined) opts.minConfidence = Number(c);
  const limit = args.getFlag(list, '--limit');
  if (limit !== undefined) opts.limit = Number(limit);

  const adapter = knowledgeAdapter.getAdapter(cwd);
  const result = await adapter.match(query, opts);
  stdout.write(JSON.stringify({
    adapter: adapter.name,
    query,
    threshold: opts.threshold == null ? knowledgeAdapter.DEFAULT_THRESHOLD : opts.threshold,
    min_occurrence: opts.minOccurrence == null ? knowledgeAdapter.DEFAULT_MIN_OCCURRENCE : opts.minOccurrence,
    min_confidence: opts.minConfidence == null ? knowledgeAdapter.DEFAULT_MIN_CONFIDENCE : opts.minConfidence,
    hits: result.hits || [],
    best: result.best || null,
  }) + '\n');
  return result;
}

module.exports = { run };
