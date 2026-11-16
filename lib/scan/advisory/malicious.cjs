'use strict';

const { normalizeName } = require('../inventory/pkgurl.cjs');

const LF = 0x0a;
const CR = 0x0d;
const ALL_VERSIONS = '*';

function _record(line) {
  const parts = line.split('\t');
  const key = parts[0] ? parts[0].trim() : '';
  if (!key) return null;
  const id = parts.length > 1 ? parts[1].trim() : '';
  const raw = parts.length > 2 ? parts[2].trim() : ALL_VERSIONS;
  if (raw === '' || raw === ALL_VERSIONS) return { key, id, versions: [ALL_VERSIONS] };
  const versions = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return { key, id, versions: versions.length ? versions : [ALL_VERSIONS] };
}

function _searchEnd(shard) {
  const buf = shard.buffer;
  let end = Number.isInteger(shard.end) ? Math.min(shard.end, buf.length) : buf.length;
  while (end > 0 && (buf[end - 1] === LF || buf[end - 1] === CR)) end -= 1;
  return end;
}

function _binarySearch(shard, key, stats) {
  const target = String(key == null ? '' : key);
  if (!shard || !Buffer.isBuffer(shard.buffer) || !target) return null;

  const buf = shard.buffer;
  let lo = 0;
  let hi = _searchEnd(shard);

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    let start = mid;
    while (start > lo && buf[start - 1] !== LF) start -= 1;
    let stop = buf.indexOf(LF, start);
    if (stop === -1 || stop > hi) stop = hi;
    if (stats) stats.probes = (stats.probes || 0) + 1;

    let lineEnd = stop;
    if (lineEnd > start && buf[lineEnd - 1] === CR) lineEnd -= 1;
    const record = _record(buf.toString('utf-8', start, lineEnd));
    const found = record ? record.key : '';
    if (found === target) return record;
    if (found < target) lo = stop + 1;
    else hi = start;
  }
  return null;
}

function _matchesVersion(versions, version) {
  if (!Array.isArray(versions) || versions.length === 0) return false;
  if (versions.includes(ALL_VERSIONS)) return true;
  const installed = _normalizeVersion(version);
  if (!installed) return false;
  return versions.some((v) => _normalizeVersion(v) === installed);
}

function _normalizeVersion(version) {
  if (version == null) return '';
  let v = String(version).trim();
  while (v.startsWith('=')) v = v.slice(1).trim();
  if (v.startsWith('v') || v.startsWith('V')) v = v.slice(1);
  return v;
}

function lookup(shard, ecosystem, name, stats) {
  const key = normalizeName(ecosystem, name);
  if (!key) return null;
  const record = _binarySearch(shard, key, stats);
  return record ? { id: record.id, versions: record.versions } : null;
}

function lookupMany(shard, ecosystem, packages) {
  const hits = [];
  if (!shard) return hits;
  for (const pkg of Array.isArray(packages) ? packages : []) {
    const isObject = pkg !== null && typeof pkg === 'object';
    const name = isObject ? pkg.name : pkg;
    const version = isObject ? pkg.version : null;
    if (isObject && typeof pkg.ecosystem === 'string' && pkg.ecosystem !== ecosystem) continue;
    const record = lookup(shard, ecosystem, name);
    if (!record || !_matchesVersion(record.versions, version)) continue;
    hits.push({ package: pkg, id: record.id, versions: record.versions });
  }
  return hits;
}

module.exports = { lookup, lookupMany, _binarySearch };
