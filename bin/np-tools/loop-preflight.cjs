'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const nubosloop = require('../../lib/nubosloop.cjs');
const { getFlag } = require('./_args.cjs');

function _parseOpts(rest) {
  const opts = {};
  const t = getFlag(rest, '--threshold');
  if (t !== undefined) opts.threshold = Number(t);
  const m = getFlag(rest, '--min-occurrence');
  if (m !== undefined) opts.minOccurrence = Number(m);
  return opts;
}

async function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const query = getFlag(list, '--query');
  if (!query) {
    throw new NubosPilotError(
      'loop-preflight-missing-query',
      'loop-preflight requires --query "<text>"',
      { hint: 'example: loop-preflight --query "implement jose JWT verification" --threshold 0.9 --min-occurrence 3' },
    );
  }
  const opts = _parseOpts(list);
  const result = await nubosloop.preflightCacheLookup(query, opts, cwd);
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

module.exports = { run };
