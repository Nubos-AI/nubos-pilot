'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { tryReadConfigPath } = require('../../lib/config.cjs');
const { createMemory } = require('../../lib/memory.cjs');

function resolveMemory(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();

  if (o.provider && o.indexEngine) {
    return createMemory({
      provider: o.provider,
      indexEngine: o.indexEngine,
      cwd,
      alpha: o.alpha,
    });
  }

  const enabled = tryReadConfigPath(cwd, 'memory.enabled', false);
  if (!enabled) {
    throw new NubosPilotError(
      'memory-disabled',
      'memory layer is disabled. Set "memory": { "enabled": true } in .nubos-pilot/config.json (ADR-0014).',
      {},
    );
  }

  const model = tryReadConfigPath(cwd, 'memory.model', 'Xenova/bge-small-en-v1.5');
  const alpha = tryReadConfigPath(cwd, 'memory.alpha', 0.6);

  const { createLocalProvider } = require('../../lib/memory-provider-local.cjs');
  const { createUsearchIndex } = require('../../lib/memory-index-usearch.cjs');

  const provider = createLocalProvider({ model });
  const indexEngine = createUsearchIndex({ dim: provider.dim });

  return createMemory({ provider, indexEngine, cwd, alpha });
}

module.exports = { resolveMemory };
