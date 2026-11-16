'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { resolveMemory } = require('./_memory-resolve.cjs');

function _parseArgs(args) {
  const out = { text: null, k: 8, type: null, phase: null, tags: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--text')  { out.text = args[++i] || null; continue; }
    if (a === '--k')     { out.k = Number(args[++i]) || 8; continue; }
    if (a === '--type')  { out.type = args[++i] || null; continue; }
    if (a === '--phase') { out.phase = args[++i] || null; continue; }
    if (a === '--tags')  { out.tags = (args[++i] || '').split(',').filter(Boolean); continue; }
    if (!a.startsWith('--') && !out.text) { out.text = a; continue; }
  }
  return out;
}

async function run(args, opts) {
  const o = opts || {};
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);
  if (!parsed.text) {
    throw new NubosPilotError('memory-query-missing-text', 'query text required (positional or --text)', {});
  }

  const filter = {};
  if (parsed.type) filter.type = parsed.type;
  if (parsed.phase) filter.phase = parsed.phase;
  if (Array.isArray(parsed.tags) && parsed.tags.length > 0) filter.tags = parsed.tags;

  const memory = resolveMemory(o);
  const hits = await memory.query(parsed.text, { k: parsed.k, filter });
  stdout.write(JSON.stringify(hits) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
