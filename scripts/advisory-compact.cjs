'use strict';

const { NubosPilotError } = require('../lib/core.cjs');
const { normalizeName, isEcosystem } = require('../lib/scan/inventory/pkgurl.cjs');
const cvss = require('./cvss.cjs');

const SCHEMA_VERSION = 1;
const MAX_SUMMARY_CHARS = 160;
const CWE_RE = /^CWE-\d{1,5}$/;
const UNRATED = 'unrated';
const UNSCORED = 'unscored';
const CVE_RE = /^CVE-\d{4}-\d{4,}$/;

const LICENSE_ALLOWLIST = Object.freeze([
  'CC-BY-4.0', 'CC-BY-3.0', 'CC0-1.0', 'MIT', 'Apache-2.0',
  'BSD-2-Clause', 'BSD-3-Clause', 'Unlicense',
]);

const DB_SEVERITY = Object.freeze({
  CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low',
});

function isLicenseAllowed(license) {
  return LICENSE_ALLOWLIST.includes(String(license || '').trim());
}

function severityOf(record) {
  const list = Array.isArray(record && record.severity) ? record.severity : [];
  let rated = false;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (Number.isFinite(entry.score) || /^CVSS:/i.test(String(entry.score || ''))) rated = true;
    if (Number.isFinite(entry.score)) {
      const mapped = cvss.severityFromScore(Number(entry.score));
      if (mapped) return mapped;
    }
    const fromVector = cvss.severityFromVector(entry.score);
    if (fromVector) return fromVector;
  }
  const dbSpecific = record && record.database_specific;
  if (dbSpecific && typeof dbSpecific.severity === 'string') {
    const mapped = DB_SEVERITY[dbSpecific.severity.toUpperCase()];
    if (mapped) return mapped;
  }
  return rated ? UNSCORED : UNRATED;
}

function cwesOf(record) {
  const out = [];
  const dbSpecific = record && record.database_specific;
  const ids = dbSpecific && Array.isArray(dbSpecific.cwe_ids) ? dbSpecific.cwe_ids : [];
  for (const raw of ids) {
    const id = String(raw || '').toUpperCase().trim();
    if (CWE_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function cvesOf(record) {
  const out = [];
  const aliases = Array.isArray(record && record.aliases) ? record.aliases : [];
  for (const raw of aliases) {
    const id = String(raw || '').toUpperCase().trim();
    if (CVE_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function summaryOf(record) {
  const raw = typeof record.summary === 'string' ? record.summary : '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > MAX_SUMMARY_CHARS
    ? collapsed.slice(0, MAX_SUMMARY_CHARS - 1) + '…'
    : collapsed;
}

const VERSION_RANGE_TYPES = Object.freeze(['ECOSYSTEM', 'SEMVER']);

function isVersionRange(range) {
  if (!range || typeof range !== 'object') return false;
  if (range.type === undefined || range.type === null || range.type === '') return true;
  return VERSION_RANGE_TYPES.includes(String(range.type).toUpperCase());
}

function rangesOf(affected) {
  const out = [];
  for (const range of Array.isArray(affected.ranges) ? affected.ranges : []) {
    if (!isVersionRange(range)) continue;
    const events = [];
    for (const event of Array.isArray(range.events) ? range.events : []) {
      if (!event || typeof event !== 'object') continue;
      if (typeof event.introduced === 'string') events.push({ introduced: event.introduced });
      else if (typeof event.fixed === 'string') events.push({ fixed: event.fixed });
      else if (typeof event.last_affected === 'string') events.push({ last_affected: event.last_affected });
    }
    if (events.length) out.push({ events });
  }
  return out;
}

function isWithdrawn(record) {
  return !!(record && typeof record.withdrawn === 'string' && record.withdrawn);
}

function isMaliciousRecord(record) {
  const id = String((record && record.id) || '');
  return id.startsWith('MAL-');
}

function compactRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (isWithdrawn(record)) return null;
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) return null;

  const entries = [];
  for (const affected of Array.isArray(record.affected) ? record.affected : []) {
    if (!affected || typeof affected !== 'object') continue;
    const pkg = affected.package;
    if (!pkg || typeof pkg !== 'object') continue;
    const ecosystem = String(pkg.ecosystem || '').split(':')[0].trim();
    if (!isEcosystem(ecosystem)) continue;
    const name = typeof pkg.name === 'string' ? pkg.name : '';
    if (!name) continue;

    const ranges = rangesOf(affected);
    const versions = (Array.isArray(affected.versions) ? affected.versions : [])
      .filter((v) => typeof v === 'string' && v);

    entries.push({
      ecosystem,
      key: normalizeName(ecosystem, name),
      malicious: isMaliciousRecord(record),
      versions,
      advisory: {
        id,
        cve: cvesOf(record),
        ranges,
        versions: ranges.length ? [] : versions.slice(0, 200),
        severity: severityOf(record),
        cwe: cwesOf(record),
        summary: summaryOf(record),
      },
    });
  }
  return entries.length ? entries : null;
}

function buildShards(records) {
  const vuln = new Map();
  const malicious = new Map();
  const stats = { records: 0, withdrawn: 0, skipped: 0, vuln_entries: 0, malicious_entries: 0 };

  for (const record of Array.isArray(records) ? records : []) {
    stats.records += 1;
    if (isWithdrawn(record)) { stats.withdrawn += 1; continue; }
    const entries = compactRecord(record);
    if (!entries) { stats.skipped += 1; continue; }

    for (const entry of entries) {
      if (entry.malicious) {
        if (!malicious.has(entry.ecosystem)) malicious.set(entry.ecosystem, new Map());
        const shard = malicious.get(entry.ecosystem);
        const versions = entry.versions.length ? entry.versions.join(',') : '*';
        shard.set(entry.key, { id: entry.advisory.id, versions });
        stats.malicious_entries += 1;
        continue;
      }
      if (!entry.advisory.ranges.length && !entry.versions.length) { stats.skipped += 1; continue; }
      if (!vuln.has(entry.ecosystem)) vuln.set(entry.ecosystem, new Map());
      const shard = vuln.get(entry.ecosystem);
      if (!shard.has(entry.key)) shard.set(entry.key, []);
      shard.get(entry.key).push(entry.advisory);
      stats.vuln_entries += 1;
    }
  }

  return { vuln, malicious, stats };
}

function renderVulnShard(shardMap) {
  const out = {};
  for (const key of [...shardMap.keys()].sort()) {
    out[key] = shardMap.get(key)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  return JSON.stringify(out);
}

function renderMaliciousShard(shardMap) {
  const lines = [];
  for (const key of [...shardMap.keys()].sort()) {
    const entry = shardMap.get(key);
    if (key.includes('\t') || key.includes('\n')) {
      throw new NubosPilotError(
        'advisory-build-unsafe-key',
        'a package key containing a tab or newline would corrupt the malicious shard',
        { key },
      );
    }
    lines.push(key + '\t' + entry.id + '\t' + entry.versions);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

module.exports = {
  SCHEMA_VERSION,
  UNRATED,
  UNSCORED,
  LICENSE_ALLOWLIST,
  MAX_SUMMARY_CHARS,
  isLicenseAllowed,
  severityOf,
  cwesOf,
  cvesOf,
  summaryOf,
  rangesOf,
  isWithdrawn,
  isMaliciousRecord,
  compactRecord,
  buildShards,
  renderVulnShard,
  renderMaliciousShard,
};
