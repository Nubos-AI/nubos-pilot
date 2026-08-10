'use strict';

const { NubosPilotError, safeAssign } = require('./core.cjs');
const learnings = require('./learnings.cjs');
const config = require('./config.cjs');

const DEFAULT_ADAPTER = 'local';
const SUPPORTED_ADAPTERS = ['local'];
const DEFAULT_HYBRID_ALPHA = 0.6;

const DEFAULT_THRESHOLD = learnings.DEFAULT_THRESHOLD;
const DEFAULT_MIN_OCCURRENCE = learnings.DEFAULT_MIN_OCCURRENCE;
const DEFAULT_MIN_CONFIDENCE = learnings.DEFAULT_MIN_CONFIDENCE;
const DEFAULT_BYPASS_THRESHOLD = learnings.DEFAULT_BYPASS_THRESHOLD;

function _readAdapterConfig(cwd) {
  const adapter = config.tryReadConfigPath(cwd, 'swarm.knowledge_adapter', DEFAULT_ADAPTER);
  return typeof adapter === 'string' && SUPPORTED_ADAPTERS.includes(adapter)
    ? adapter
    : DEFAULT_ADAPTER;
}

function _resolveMemoryForHybrid(cwd, opts) {
  if (opts && opts.memoryOverride) return { memory: opts.memoryOverride, degraded: null };
  if (!config.tryReadConfigPath(cwd, 'memory.enabled', false)) {
    return { memory: null, degraded: null };
  }
  let resolveMemory;
  try { ({ resolveMemory } = require('../bin/np-tools/_memory-resolve.cjs')); }
  catch (err) {
    return { memory: null, degraded: { code: 'memory-resolver-unavailable', message: err && err.message } };
  }
  try {
    return { memory: resolveMemory({ cwd }), degraded: null };
  } catch (err) {
    return {
      memory: null,
      degraded: { code: (err && err.code) || 'memory-resolve-failed', message: err && err.message },
    };
  }
}

function _projectLearning(learning, now) {
  if (!learning || typeof learning !== 'object') return null;
  const projected = safeAssign({}, learning);
  delete projected.tokens;
  projected.confidence = learnings._confidence(learning, now);
  return projected;
}

function _hybridMerge(bm25Hits, vectorHits, alpha, byFp, now) {
  const lookup = byFp instanceof Map ? byFp : new Map();
  const a = Number.isFinite(alpha) ? alpha : DEFAULT_HYBRID_ALPHA;
  const at = Number.isFinite(now) ? now : Date.now();

  const bm25ByFp = new Map();
  for (const h of bm25Hits || []) {
    if (h && h.fingerprint) bm25ByFp.set(h.fingerprint, h);
  }
  const vecByFp = new Map();
  for (const v of vectorHits || []) {
    if (!v || !v.fingerprint || typeof v.score !== 'number') continue;
    const prev = vecByFp.get(v.fingerprint);
    if (prev == null || v.score > prev) vecByFp.set(v.fingerprint, v.score);
  }

  const merged = [];
  for (const fp of new Set([...bm25ByFp.keys(), ...vecByFp.keys()])) {
    const bm = bm25ByFp.get(fp) || null;
    const base = bm || _projectLearning(lookup.get(fp), at);
    if (!base) continue;
    let similarity;
    let retrieval;
    if (bm && vecByFp.has(fp)) {
      similarity = a * (bm.similarity || 0) + (1 - a) * vecByFp.get(fp);
      retrieval = 'hybrid';
    } else if (bm) {
      similarity = bm.similarity || 0;
      retrieval = 'bm25';
    } else {
      similarity = vecByFp.get(fp);
      retrieval = 'vector';
    }
    merged.push(safeAssign({}, base, { similarity, retrieval }));
  }
  merged.sort((x, y) =>
    (y.similarity * (y.confidence != null ? y.confidence : 1))
      - (x.similarity * (x.confidence != null ? x.confidence : 1))
    || y.similarity - x.similarity
    || (y.occurrence || 0) - (x.occurrence || 0));
  return merged;
}

async function _ensureLearningsIndexed(memory, allLearnings) {
  if (!memory || typeof memory.index !== 'function') return;
  if (!Array.isArray(allLearnings) || allLearnings.length === 0) return;
  const records = allLearnings
    .filter((l) => l && typeof l.fingerprint === 'string' && typeof l.pattern === 'string')
    .map((l) => ({
      id: l.fingerprint,
      type: 'learning',
      title: l.pattern,
      body: typeof l.outcome === 'string' ? l.outcome : '',
    }));
  if (records.length > 0) await memory.index(records);
}

function _tagLexical(result, degraded) {
  const hits = (result.hits || []).map((h) => safeAssign({}, h, { retrieval: 'bm25' }));
  return { hits, best: hits[0] || null, degraded: degraded || null };
}

function _localAdapter(cwd) {
  async function _match(query, opts) {
    const o = opts || {};
    const threshold = o.threshold != null ? o.threshold : DEFAULT_THRESHOLD;
    const minOcc = o.minOccurrence != null ? o.minOccurrence : DEFAULT_MIN_OCCURRENCE;
    const minConf = o.minConfidence != null ? o.minConfidence : DEFAULT_MIN_CONFIDENCE;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const bm25 = learnings.matchExistingLearning(query, cwd, o);

    const resolved = _resolveMemoryForHybrid(cwd, o);
    if (!resolved.memory) {
      return _tagLexical(bm25, resolved.degraded);
    }

    const allLearnings = learnings.listLearnings(cwd);
    const byFp = new Map();
    for (const l of allLearnings) {
      if (l && l.fingerprint) byFp.set(l.fingerprint, l);
    }

    let vectorHits;
    try {
      await _ensureLearningsIndexed(resolved.memory, allLearnings);
      const raw = await resolved.memory.query(query, {
        k: o.limit || 5,
        filter: { type: 'learning' },
      });
      vectorHits = (raw || []).map((v) => ({
        fingerprint: (v && v.record && v.record.id) || (v && v.id) || null,
        score: v && typeof v.score === 'number' ? v.score : null,
      }));
    } catch (err) {
      return _tagLexical(bm25, {
        code: (err && err.code) || 'memory-query-failed',
        message: err && err.message,
      });
    }

    const alpha = config.tryReadConfigPath(cwd, 'memory.alpha', DEFAULT_HYBRID_ALPHA);
    const merged = _hybridMerge(bm25.hits, vectorHits, alpha, byFp, now);
    const hits = merged.filter((h) => (
      h.retrieval !== 'vector'
        ? true
        : (h.similarity >= threshold
          && (h.occurrence || 0) >= minOcc
          && (h.confidence != null ? h.confidence : 0) >= minConf)
    ));
    return { hits, best: hits[0] || null, degraded: null };
  }

  return {
    name: 'local',
    isAvailable: () => true,
    match: _match,
    log: (entry) => learnings.logLearning(entry, cwd),
    list: () => learnings.listLearnings(cwd),
  };
}

function getAdapter(cwd, override) {
  const name = override || _readAdapterConfig(cwd);
  if (name === 'local') return _localAdapter(cwd);
  throw new NubosPilotError(
    'knowledge-adapter-unknown',
    'Unknown knowledge adapter: ' + name,
    { name, supported: SUPPORTED_ADAPTERS.slice() },
  );
}

module.exports = {
  DEFAULT_ADAPTER,
  SUPPORTED_ADAPTERS,
  DEFAULT_THRESHOLD,
  DEFAULT_MIN_OCCURRENCE,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_BYPASS_THRESHOLD,
  DEFAULT_HYBRID_ALPHA,
  getAdapter,
  _readAdapterConfig,
  _hybridMerge,
  _projectLearning,
  _ensureLearningsIndexed,
};
