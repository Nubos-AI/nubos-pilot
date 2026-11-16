'use strict';

const fs = require('node:fs');
const { NubosPilotError } = require('../../lib/core.cjs');
const { resolveMemory } = require('./_memory-resolve.cjs');

function _parseArgs(args) {
  const out = {
    type: null, phase: null, title: null, body: null, bodyFile: null,
    tags: null, provenance: null, id: null, skipIfDisabled: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--skip-if-disabled') { out.skipIfDisabled = true; continue; }
    if (a === '--type')        { out.type = args[++i] || null; continue; }
    if (a === '--phase')       { out.phase = args[++i] || null; continue; }
    if (a === '--title')       { out.title = args[++i] || null; continue; }
    if (a === '--body')        { out.body = args[++i] || null; continue; }
    if (a === '--body-file')   { out.bodyFile = args[++i] || null; continue; }
    if (a === '--tags')        { out.tags = (args[++i] || '').split(',').filter(Boolean); continue; }
    if (a === '--provenance')  { out.provenance = args[++i] || null; continue; }
    if (a === '--id')          { out.id = args[++i] || null; continue; }
  }
  return out;
}

async function run(args, opts) {
  const o = opts || {};
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);

  let body = parsed.body || '';
  if (parsed.bodyFile) {
    try { body = fs.readFileSync(parsed.bodyFile, 'utf-8'); }
    catch (err) {
      throw new NubosPilotError(
        'memory-body-file-read-failed',
        'failed to read --body-file: ' + (err && err.message),
        { path: parsed.bodyFile },
      );
    }
  }

  // The memory layer is opt-in and additive: a caller wired into a workflow must
  // not break that workflow just because the operator never turned memory on.
  // Only `memory-disabled` is absorbed — a config that opts IN but cannot resolve
  // (missing optional deps, corrupt index) is a real failure and still throws.
  let memory;
  try {
    memory = resolveMemory(o);
  } catch (err) {
    if (parsed.skipIfDisabled && err && err.code === 'memory-disabled') {
      stdout.write(JSON.stringify({ skipped: true, reason: 'memory-disabled' }) + '\n');
      return 0;
    }
    throw err;
  }

  const result = await memory.add({
    id: parsed.id || undefined,
    type: parsed.type,
    phase: parsed.phase,
    title: parsed.title,
    body,
    tags: parsed.tags || undefined,
    provenance: parsed.provenance || undefined,
  });
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
