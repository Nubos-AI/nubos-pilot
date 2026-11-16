'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync, appendJsonl, withFileLockAsync, NubosPilotError, projectStateDir } = require('./core.cjs');
const { validate } = require('./validate.cjs');

let _memLog;
function _log() {
  if (!_memLog) _memLog = require('./logger.cjs').child('memory');
  return _memLog;
}

const TYPE_ENUM = new Set(['learning', 'handoff', 'critic', 'research']);
const PROVENANCE_ENUM = new Set(['VERIFIED', 'CITED', 'ASSUMED', 'CACHED']);
const SCHEMA_VERSION = 1;

const RECORD_SCHEMA = 'memory-record.v1';
const MANIFEST_SCHEMA = 'memory-manifest.v1';

const _RECORD_CODE_BY_FIELD = Object.freeze({
  type: 'memory-invalid-type',
  title: 'memory-missing-title',
  body: 'memory-missing-body',
  tags: 'memory-invalid-tags',
  provenance: 'memory-invalid-provenance',
  id: 'memory-invalid-id',
  phase: 'memory-invalid-phase',
});

function _memoryRoot(cwd) {
  return path.join(projectStateDir(cwd || process.cwd()), 'memory');
}

function _recordsPath(cwd) { return path.join(_memoryRoot(cwd), 'records.jsonl'); }
function _indexPath(cwd) { return path.join(_memoryRoot(cwd), 'index.usearch'); }
function _manifestPath(cwd) { return path.join(_memoryRoot(cwd), 'manifest.json'); }

function _validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new NubosPilotError('memory-invalid-record', 'record must be object', {});
  }
  const errors = validate(record, RECORD_SCHEMA);
  if (errors.length === 0) return;
  const first = errors[0];
  const code = _RECORD_CODE_BY_FIELD[first.field] || 'memory-invalid-record';
  throw new NubosPilotError(code, first.message, { field: first.field, value: record[first.field] });
}

function _readRecordsJsonlWithStats(cwd) {
  const p = _recordsPath(cwd);
  if (!fs.existsSync(p)) return { records: [], skipped: 0 };
  const raw = fs.readFileSync(p, 'utf-8');
  const records = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); }
    catch { skipped += 1; continue; }
    if (validate(rec, RECORD_SCHEMA).length > 0) { skipped += 1; continue; }
    records.push(rec);
  }
  if (skipped > 0) {
    _log().warn('skipped corrupt records.jsonl lines', {
      event: 'memory-records-corrupt-lines',
      file: 'records.jsonl',
      skipped,
      hint: 'run `memory-rebuild` to repair',
    });
  }
  return { records, skipped };
}

function _readRecordsJsonl(cwd) {
  return _readRecordsJsonlWithStats(cwd).records;
}

function _writeManifest(cwd, manifest) {
  fs.mkdirSync(_memoryRoot(cwd), { recursive: true });
  atomicWriteFileSync(_manifestPath(cwd), JSON.stringify(manifest, null, 2));
}

function _readManifest(cwd) {
  const p = _manifestPath(cwd);
  if (!fs.existsSync(p)) return null;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  const errors = validate(obj, MANIFEST_SCHEMA);
  if (errors.length > 0) {
    _log().warn('ignoring corrupt memory manifest', {
      event: 'memory-manifest-corrupt',
      file: 'manifest.json',
      violation: errors[0].message,
      hint: 'manifest will be rewritten on next index/rebuild; run `memory-rebuild` if model/dim changed',
    });
    return null;
  }
  return obj;
}

function _embeddingText(record) {
  return record.title + '\n' + record.body;
}

function _normalizeRecord(record) {
  return {
    id: record.id || crypto.randomUUID(),
    type: record.type,
    phase: record.phase || null,
    title: record.title,
    body: record.body,
    tags: Array.isArray(record.tags) ? [...record.tags] : [],
    provenance: record.provenance || null,
    created_at: record.created_at || new Date().toISOString(),
  };
}

function createMemory(opts) {
  const o = opts || {};
  const provider = o.provider;
  const indexEngine = o.indexEngine;
  const workingDir = o.cwd || process.cwd();
  const alpha = o.alpha != null ? o.alpha : 0.6;

  if (!provider || typeof provider.embed !== 'function') {
    throw new NubosPilotError('memory-missing-provider', 'provider with embed() required', {});
  }
  if (typeof provider.modelId !== 'string' || typeof provider.dim !== 'number') {
    throw new NubosPilotError('memory-invalid-provider', 'provider must expose modelId:string and dim:number', {});
  }
  if (!indexEngine || typeof indexEngine.add !== 'function' || typeof indexEngine.search !== 'function') {
    throw new NubosPilotError('memory-missing-index', 'indexEngine with add() and search() required', {});
  }

  let _loaded = false;
  let _driftDetected = false;
  function _detectDrift() {
    if (typeof indexEngine.size !== 'function') {
      _driftDetected = false;
      return;
    }
    const indexSize = Number(indexEngine.size());
    if (!Number.isFinite(indexSize)) {
      _driftDetected = false;
      return;
    }
    const stats = _readRecordsJsonlWithStats(workingDir);
    const reconciledCount = stats.records.length + stats.skipped;
    if (indexSize === reconciledCount) {
      _driftDetected = false;
      return;
    }
    _driftDetected = true;
    _log().warn('memory index/records drift detected', {
      event: 'memory-drift',
      index_size: indexSize,
      record_count: stats.records.length,
      skipped: stats.skipped,
      hint: 'previous index() may have crashed between writes; run `memory-rebuild` to recover',
    });
  }

  function _ensureLoaded() {
    if (_loaded) return;
    fs.mkdirSync(_memoryRoot(workingDir), { recursive: true });
    if (typeof indexEngine.loadSync === 'function' && fs.existsSync(_indexPath(workingDir))) {
      indexEngine.loadSync(_indexPath(workingDir));
    }
    _loaded = true;
    _detectDrift();
  }

  function _assertNoDrift() {
    if (!_driftDetected) return;
    throw new NubosPilotError(
      'memory-drift-detected',
      'memory store is out of sync: usearch index and records.jsonl disagree. '
      + 'Refusing to mutate. Run `memory-rebuild` first.',
      {},
    );
  }

  function _checkModelMatch() {
    const manifest = _readManifest(workingDir);
    if (!manifest) return;
    if (manifest.model !== provider.modelId) {
      throw new NubosPilotError(
        'memory-model-mismatch',
        `manifest model=${manifest.model} does not match provider model=${provider.modelId}; run rebuild`,
        { manifest_model: manifest.model, provider_model: provider.modelId },
      );
    }
    if (manifest.dim !== provider.dim) {
      throw new NubosPilotError(
        'memory-dim-mismatch',
        `manifest dim=${manifest.dim} does not match provider dim=${provider.dim}; run rebuild`,
        { manifest_dim: manifest.dim, provider_dim: provider.dim },
      );
    }
  }

  async function _writeIndexAndManifest() {
    if (typeof indexEngine.saveSync === 'function') {
      indexEngine.saveSync(_indexPath(workingDir));
    }
    if (!_readManifest(workingDir)) {
      _writeManifest(workingDir, {
        schema_version: SCHEMA_VERSION,
        model: provider.modelId,
        dim: provider.dim,
        alpha,
        created_at: new Date().toISOString(),
      });
    }
  }

  async function index(records) {
    if (!Array.isArray(records)) {
      throw new NubosPilotError('memory-invalid-records', 'records must be array', {});
    }
    for (const r of records) _validateRecord(r);
    if (records.length === 0) return { added: 0, skipped: 0 };

    return withFileLockAsync(_recordsPath(workingDir), async () => {
      _ensureLoaded();
      _assertNoDrift();
      _checkModelMatch();

      const existing = _readRecordsJsonl(workingDir);
      const existingIds = new Set(existing.map((r) => r.id));

      const normalized = records.map(_normalizeRecord);
      const newOnes = normalized.filter((r) => !existingIds.has(r.id));
      if (newOnes.length === 0) return { added: 0, skipped: records.length };

      const texts = newOnes.map(_embeddingText);
      const vectors = await provider.embed(texts);
      if (!Array.isArray(vectors) || vectors.length !== newOnes.length) {
        throw new NubosPilotError(
          'memory-embed-mismatch',
          `provider returned ${(vectors || []).length} vectors for ${newOnes.length} inputs`,
          {},
        );
      }

      const recordsPath = _recordsPath(workingDir);
      let priorSize = 0;
      try { priorSize = fs.statSync(recordsPath).size; }
      catch (err) { if (!err || err.code !== 'ENOENT') throw err; }

      const addedIds = [];
      try {
        for (const r of newOnes) {
          appendJsonl(recordsPath, r, { lock: false, mode: 0o600 });
        }
        for (let i = 0; i < newOnes.length; i++) {
          indexEngine.add(newOnes[i].id, vectors[i]);
          addedIds.push(newOnes[i].id);
        }
        await _writeIndexAndManifest();
      } catch (err) {
        if (typeof indexEngine.remove === 'function') {
          for (const id of addedIds) {
            try { indexEngine.remove(id); } catch { /* best effort */ }
          }
        } else {
          _loaded = false;
        }
        try { fs.truncateSync(recordsPath, priorSize); } catch {}
        throw err;
      }

      return { added: newOnes.length, skipped: records.length - newOnes.length };
    }, { timeoutMs: 60000 });
  }

  async function add(record) {
    _validateRecord(record);
    const norm = _normalizeRecord(record);
    const result = await index([norm]);
    return { added: result.added > 0, skipped: result.skipped > 0, id: norm.id };
  }

  async function query(text, opts) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new NubosPilotError('memory-empty-query', 'query text required as non-empty string', {});
    }
    const o = opts || {};
    const k = o.k || 8;
    const filter = o.filter || {};

    _ensureLoaded();
    _checkModelMatch();

    if (typeof indexEngine.size === 'function' && indexEngine.size() === 0) return [];

    const vectors = await provider.embed([text]);
    if (!Array.isArray(vectors) || vectors.length !== 1) {
      throw new NubosPilotError('memory-embed-mismatch', 'provider must return one vector for query', {});
    }
    const hits = indexEngine.search(vectors[0], k);
    if (!Array.isArray(hits) || hits.length === 0) return [];

    const records = _readRecordsJsonl(workingDir);
    const byId = new Map(records.map((r) => [r.id, r]));

    const out = [];
    for (const hit of hits) {
      const rec = byId.get(hit.id);
      if (!rec) continue;
      if (filter.type && rec.type !== filter.type) continue;
      if (filter.phase && rec.phase !== filter.phase) continue;
      if (Array.isArray(filter.tags) && filter.tags.length > 0) {
        const recTags = new Set(rec.tags || []);
        const overlap = filter.tags.some((t) => recTags.has(t));
        if (!overlap) continue;
      }
      out.push({ id: hit.id, score: hit.score, record: rec });
    }
    return out;
  }

  async function rebuild() {
    return withFileLockAsync(_recordsPath(workingDir), async () => {
      fs.mkdirSync(_memoryRoot(workingDir), { recursive: true });
      if (typeof indexEngine.clear === 'function') indexEngine.clear();
      _loaded = true;

      const records = _readRecordsJsonl(workingDir);
      if (records.length === 0) {
        _writeManifest(workingDir, {
          schema_version: SCHEMA_VERSION,
          model: provider.modelId,
          dim: provider.dim,
          alpha,
          rebuilt_at: new Date().toISOString(),
        });
        if (typeof indexEngine.saveSync === 'function') {
          indexEngine.saveSync(_indexPath(workingDir));
        }
        return { reembedded: 0 };
      }

      const texts = records.map(_embeddingText);
      const vectors = await provider.embed(texts);
      if (!Array.isArray(vectors) || vectors.length !== records.length) {
        throw new NubosPilotError(
          'memory-embed-mismatch',
          `provider returned ${(vectors || []).length} vectors for ${records.length} inputs`,
          {},
        );
      }
      for (let i = 0; i < records.length; i++) {
        indexEngine.add(records[i].id, vectors[i]);
      }

      if (typeof indexEngine.saveSync === 'function') {
        indexEngine.saveSync(_indexPath(workingDir));
      }
      _writeManifest(workingDir, {
        schema_version: SCHEMA_VERSION,
        model: provider.modelId,
        dim: provider.dim,
        alpha,
        rebuilt_at: new Date().toISOString(),
      });
      return { reembedded: records.length };
    }, { timeoutMs: 60000 });
  }

  function stats() {
    const records = _readRecordsJsonl(workingDir);
    const manifest = _readManifest(workingDir) || {};
    return {
      count: records.length,
      dim: manifest.dim != null ? manifest.dim : provider.dim,
      model: manifest.model || provider.modelId,
      schema_version: manifest.schema_version != null ? manifest.schema_version : null,
      alpha: manifest.alpha != null ? manifest.alpha : alpha,
      created_at: manifest.created_at || null,
      rebuilt_at: manifest.rebuilt_at || null,
    };
  }

  return { index, add, query, rebuild, stats };
}

module.exports = {
  createMemory,
  TYPE_ENUM,
  PROVENANCE_ENUM,
  SCHEMA_VERSION,
};
