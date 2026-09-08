'use strict';

const { resolveMemory } = require('./_memory-resolve.cjs');

function _parseArgs() { return {}; }

async function run(args, opts) {
  const o = opts || {};
  const stdout = o.stdout || process.stdout;
  const memory = resolveMemory(o);
  const result = await memory.rebuild();
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
