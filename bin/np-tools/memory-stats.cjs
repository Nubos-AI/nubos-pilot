'use strict';

const { resolveMemory } = require('./_memory-resolve.cjs');

function _parseArgs() { return {}; }

function run(args, opts) {
  const o = opts || {};
  const stdout = o.stdout || process.stdout;
  const memory = resolveMemory(o);
  stdout.write(JSON.stringify(memory.stats()) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
