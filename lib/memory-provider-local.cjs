'use strict';

const path = require('node:path');
const os = require('node:os');
const { NubosPilotError } = require('./core.cjs');

const KNOWN_DIMS = Object.freeze({
  'Xenova/bge-small-en-v1.5': 384,
  'Xenova/bge-base-en-v1.5': 768,
  'Xenova/bge-multilingual-base': 768,
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/all-MiniLM-L12-v2': 384,
});

function createLocalProvider(opts) {
  const o = opts || {};
  const model = o.model || 'Xenova/bge-small-en-v1.5';
  const cacheDir = o.cacheDir || path.join(os.homedir(), '.cache', 'nubos-pilot', 'models');

  if (!Object.prototype.hasOwnProperty.call(KNOWN_DIMS, model)) {
    throw new NubosPilotError(
      'memory-model-not-whitelisted',
      `model '${model}' is not in the audited whitelist. Allowed: ${Object.keys(KNOWN_DIMS).join(', ')}`,
      { model, allowed: Object.keys(KNOWN_DIMS) },
    );
  }

  let transformers;
  try {
    transformers = require('@huggingface/transformers');
  } catch (err) {
    throw new NubosPilotError(
      'memory-transformers-not-installed',
      '@huggingface/transformers is not installed. Run `npm install --include=optional` to enable the local memory provider, or set memory.enabled=false in .nubos-pilot/config.json',
      { model, require_error: err && err.message },
    );
  }

  try { transformers.env.cacheDir = cacheDir; } catch {}
  try { transformers.env.allowLocalModels = true; } catch {}

  let pipelinePromise = null;
  function _ensurePipeline() {
    if (!pipelinePromise) {
      pipelinePromise = transformers.pipeline('feature-extraction', model);
    }
    return pipelinePromise;
  }

  const dim = KNOWN_DIMS[model] || o.dim || 384;

  return {
    modelId: model,
    dim,
    cacheDir,
    async embed(texts) {
      const extractor = await _ensurePipeline();
      const out = [];
      for (const text of texts) {
        const tensor = await extractor(text, { pooling: 'mean', normalize: true });
        out.push(new Float32Array(tensor.data));
      }
      return out;
    },
  };
}

module.exports = { createLocalProvider, KNOWN_DIMS };
