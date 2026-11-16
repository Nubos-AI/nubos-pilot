'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { NubosPilotError, atomicWriteFileSync, withFileLock, findProjectRoot } = require('./core.cjs');
const { validate } = require('./validate.cjs');
const config = require('./config.cjs');
const { DEFAULT_COMPRESSION } = require('./config-defaults.cjs');
const logger = require('./logger.cjs').child('elision');

const STORE_VERSION = 1;
const STORE_SCHEMA = 'elision-entry.v1';
const HASH_LEN = 12;
const HASH_RE = /^[a-f0-9]{12}$/;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_VERIFY_MAX_BYTES = 2000;

function hashOf(text) {
  return crypto.createHash('sha256').update(text == null ? '' : String(text)).digest('hex').slice(0, HASH_LEN);
}

function _elisionDir(cwd) {
  let root;
  try { root = findProjectRoot(cwd); }
  catch { root = cwd || process.cwd(); }
  return path.join(root, '.nubos-pilot', 'elision');
}

function _entryPath(cwd, hash) {
  return path.join(_elisionDir(cwd), hash + '.json');
}

function _isExpired(entry, now) {
  if (!entry || typeof entry.created_at !== 'string') return true;
  const created = Date.parse(entry.created_at);
  if (!Number.isFinite(created)) return true;
  const ttl = Number.isFinite(entry.ttl_ms) ? entry.ttl_ms : DEFAULT_TTL_MS;
  if (ttl <= 0) return false;
  return now - created > ttl;
}

function store(original, meta, cwd) {
  const text = original == null ? '' : String(original);
  const m = meta || {};
  const hash = hashOf(text);
  if (!HASH_RE.test(hash)) {
    throw new NubosPilotError('elision-hash-invalid', 'computed Elision hash is malformed', { hash });
  }
  const target = _entryPath(cwd, hash);
  return withFileLock(target, () => {
    if (fs.existsSync(target)) return hash;
    const entry = {
      version: STORE_VERSION,
      hash,
      original: text,
      type: typeof m.type === 'string' ? m.type.slice(0, 64) : 'plain',
      created_at: new Date().toISOString(),
      ttl_ms: Number.isFinite(m.ttlMs) ? Math.max(0, Math.round(m.ttlMs)) : DEFAULT_TTL_MS,
      original_bytes: Buffer.byteLength(text, 'utf-8'),
      compressed_bytes: Number.isFinite(m.compressedBytes) ? Math.max(0, Math.round(m.compressedBytes)) : 0,
    };
    const errors = validate(entry, STORE_SCHEMA);
    if (errors.length) {
      throw new NubosPilotError('elision-entry-invalid', 'refusing to persist malformed Elision entry', { errors });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWriteFileSync(target, JSON.stringify(entry), 'utf-8', 0o600);
    logger.debug('stored', { hash, type: entry.type, original_bytes: entry.original_bytes });
    return hash;
  });
}

function retrieve(hash, cwd) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    return { status: 'not_found', hash: String(hash) };
  }
  const target = _entryPath(cwd, hash);
  let raw;
  try { raw = fs.readFileSync(target, 'utf-8'); }
  catch { return { status: 'not_found', hash }; }
  let entry;
  try { entry = JSON.parse(raw); }
  catch { return { status: 'not_found', hash }; }
  if (_isExpired(entry, Date.now())) {
    return { status: 'expired', hash, ttl_ms: entry.ttl_ms, created_at: entry.created_at };
  }
  return {
    status: 'ok',
    hash,
    original: typeof entry.original === 'string' ? entry.original : '',
    type: entry.type || 'plain',
    original_bytes: entry.original_bytes || 0,
  };
}

function prune(cwd) {
  const dir = _elisionDir(cwd);
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return { removed: 0 }; }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(dir, name);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { continue; }
    if (_isExpired(entry, now)) {
      try { fs.unlinkSync(p); removed += 1; }
      catch { /* leave lapsed entry for the next prune */ }
    }
  }
  if (removed) logger.info('pruned', { removed });
  return { removed };
}

function compressionContext(cwd) {
  let cfg;
  try { cfg = config.tryReadConfigPath(cwd, 'compression', DEFAULT_COMPRESSION) || DEFAULT_COMPRESSION; }
  catch { cfg = DEFAULT_COMPRESSION; }
  const enabled = cfg.enabled === true;
  const elisionEnabled = enabled && (!cfg.elision || cfg.elision.enabled !== false);
  const ttlMs = cfg.elision && Number.isFinite(cfg.elision.ttl_ms) ? cfg.elision.ttl_ms : undefined;
  const storeFn = elisionEnabled
    ? (original, type) => {
        try { return store(original, { type, ttlMs }, cwd); }
        catch { return null; }
      }
    : null;
  const os = cfg.output_steering || {};
  const er = os.effort_routing || {};
  const baseEffort = typeof er.base_effort === 'string' && er.base_effort ? er.base_effort : null;
  const outputSteering = {
    enabled: enabled && os.enabled === true,
    profile: typeof os.verbosity_profile === 'string' ? os.verbosity_profile : 'balanced',
    effortRouting: enabled && os.enabled === true && er.enabled === true && baseEffort !== null,
    baseEffort,
    mechanicalEffort: typeof er.mechanical_effort === 'string' ? er.mechanical_effort : 'low',
  };
  return {
    enabled,
    store: storeFn,
    minBlockBytes: Number.isFinite(cfg.min_block_bytes) ? cfg.min_block_bytes : undefined,
    verifyMaxBytes: Number.isFinite(cfg.verify_max_bytes) ? cfg.verify_max_bytes : DEFAULT_VERIFY_MAX_BYTES,
    outputSteering,
    cacheAlign: enabled && !!(cfg.cache_align && cfg.cache_align.enabled === true),
  };
}

module.exports = {
  STORE_VERSION,
  HASH_LEN,
  HASH_RE,
  DEFAULT_TTL_MS,
  hashOf,
  store,
  retrieve,
  prune,
  compressionContext,
};
