'use strict';

const finding = require('../finding.cjs');
const db = require('./db.cjs');
const ranges = require('./ranges.cjs');
const malicious = require('./malicious.cjs');

const RULES = Object.freeze({
  VULNERABILITY: Object.freeze({
    id: 'NPS-0300',
    rule_name: 'known_vulnerability',
    category: 'vulnerable-dependency',
  }),
  DB_MISSING: Object.freeze({
    id: 'NPS-0301',
    rule_name: 'advisory_db_unavailable',
    category: 'scan-coverage',
    severity: 'medium',
    reminder: 'No advisory snapshot was found, so dependencies were not checked for known vulnerabilities. Reinstall nubos-pilot or run `np-tools scan db-update`.',
  }),
  DB_UNVERIFIED: Object.freeze({
    id: 'NPS-0302',
    rule_name: 'advisory_db_integrity_failed',
    category: 'scan-coverage',
    severity: 'high',
    reminder: 'The advisory snapshot failed its integrity check, so no vulnerability result can be trusted. Reinstall nubos-pilot or run `np-tools scan db-update`.',
  }),
  ECOSYSTEM_UNSUPPORTED: Object.freeze({
    id: 'NPS-0303',
    rule_name: 'ecosystem_version_matching_unsupported',
    category: 'scan-coverage',
    severity: 'low',
    reminder: 'Version-range matching is not implemented for this ecosystem, so its dependencies were not checked. This is a known gap, not a clean result.',
  }),
  MALICIOUS: Object.freeze({
    id: 'NPS-0400',
    rule_name: 'malicious_package',
    category: 'supply-chain',
    severity: 'critical',
    cwe: ['CWE-506'],
    reminder: 'This package version is recorded as malicious. Remove it, rotate any credentials the install could have reached, and verify the intended package name for a typosquat.',
  }),
});

const STALE_DAYS = 90;
const UNRATED_SEVERITY = 'medium';
const UNSCORED_SEVERITY = 'high';

function _advisorySeverity(raw) {
  const value = String(raw == null ? '' : raw).toLowerCase().trim();
  if (value === 'unscored') return UNSCORED_SEVERITY;
  if (value === '' || value === 'unknown' || value === 'unrated') return UNRATED_SEVERITY;
  return value;
}

function _coverageFinding(rule, extra) {
  return finding.make(Object.assign({
    id: rule.id,
    rule_name: rule.rule_name,
    scanner: 'advisory',
    source: 'advisory',
    category: rule.category,
    severity: rule.severity,
    cwe: rule.cwe || [],
    title: rule.rule_name,
    reminder: rule.reminder,
  }, extra || {}));
}

function _vulnFinding(pkg, advisory) {
  const label = advisory.cve && advisory.cve.length ? advisory.cve[0] : advisory.id;
  const fixed = _firstFixed(pkg.ecosystem, pkg.version, advisory);
  return finding.make({
    id: RULES.VULNERABILITY.id,
    rule_name: RULES.VULNERABILITY.rule_name,
    scanner: 'advisory',
    source: 'advisory',
    category: RULES.VULNERABILITY.category,
    severity: _advisorySeverity(advisory.severity),
    cwe: advisory.cwe,
    file: pkg.source,
    title: label + ': ' + (advisory.summary || pkg.name),
    reminder: fixed
      ? 'Upgrade ' + pkg.name + ' to ' + fixed + ' or later.'
      : 'No fixed version is recorded for this advisory. Assess whether the dependency can be removed or replaced.',
    package: { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem },
    fixed_version: fixed,
  });
}

function _maliciousFinding(pkg, record) {
  return finding.make({
    id: RULES.MALICIOUS.id,
    rule_name: RULES.MALICIOUS.rule_name,
    scanner: 'malicious',
    source: 'advisory',
    category: RULES.MALICIOUS.category,
    severity: RULES.MALICIOUS.severity,
    cwe: RULES.MALICIOUS.cwe,
    file: pkg.source,
    title: record.id + ': ' + pkg.name + ' is a known malicious package',
    reminder: RULES.MALICIOUS.reminder,
    package: { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem },
  });
}

function _normalizeVersionToken(version) {
  return String(version == null ? '' : version).trim().replace(/^[=v]+/i, '');
}

function _maliciousVersions(record) {
  const raw = record && record.versions;
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  if (typeof raw === 'string') return raw.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

function _maliciousHit(record, version) {
  const versions = _maliciousVersions(record);
  if (!versions.length || versions.includes('*')) return true;
  if (!version) return false;
  const wanted = _normalizeVersionToken(version);
  return versions.some((v) => _normalizeVersionToken(v) === wanted);
}

function _matches(ecosystem, version, advisory) {
  if (!version) return false;
  const explicit = Array.isArray(advisory.versions) ? advisory.versions : [];
  if (explicit.length) {
    const wanted = _normalizeVersionToken(version);
    return explicit.some((v) => _normalizeVersionToken(v) === wanted);
  }
  const list = Array.isArray(advisory.ranges) ? advisory.ranges : [];
  if (!list.length) return false;
  try { return ranges.inRange(ecosystem, version, list); }
  catch { return false; }
}

function _firstFixed(ecosystem, version, advisory) {
  if (!ranges.isSupported(ecosystem)) return null;
  const list = Array.isArray(advisory.ranges) ? advisory.ranges : [];
  if (!list.length) return null;
  try { return ranges.firstFixed(ecosystem, version, list); }
  catch { return null; }
}

function scanInventory(inventory, opts) {
  const o = opts || {};
  const packages = Array.isArray(inventory && inventory.packages) ? inventory.packages : [];
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const dir = o.dir !== undefined ? o.dir : db.resolveDbDir(o);

  const coverage = {
    db_present: false,
    db_dir: dir || null,
    generated_at: null,
    age_days: null,
    stale: false,
    ecosystems_checked: [],
    ecosystems_unsupported: [],
    ecosystems_without_shard: [],
    packages_total: packages.length,
    packages_checked: 0,
    packages_without_version: 0,
  };
  const findings = [];

  if (!dir) {
    return { findings: [_coverageFinding(RULES.DB_MISSING)], coverage };
  }

  let manifest;
  try { manifest = db.loadManifest(dir); }
  catch (err) {
    return {
      findings: [_coverageFinding(RULES.DB_UNVERIFIED, { reminder: RULES.DB_UNVERIFIED.reminder + ' (' + (err && err.code) + ')' })],
      coverage,
    };
  }
  if (!manifest) {
    return { findings: [_coverageFinding(RULES.DB_MISSING)], coverage };
  }

  coverage.db_present = true;
  coverage.generated_at = manifest.generated_at || null;
  const generated = Date.parse(coverage.generated_at || '');
  if (Number.isFinite(generated)) {
    coverage.age_days = Math.floor((now - generated) / 86400000);
    coverage.stale = coverage.age_days > STALE_DAYS;
  }

  const byEco = new Map();
  for (const pkg of packages) {
    if (!pkg || !pkg.ecosystem) continue;
    if (!byEco.has(pkg.ecosystem)) byEco.set(pkg.ecosystem, []);
    byEco.get(pkg.ecosystem).push(pkg);
  }

  for (const ecosystem of [...byEco.keys()].sort()) {
    const group = byEco.get(ecosystem);

    if (!ranges.isSupported(ecosystem)) {
      coverage.ecosystems_unsupported.push(ecosystem);
      findings.push(_coverageFinding(RULES.ECOSYSTEM_UNSUPPORTED, {
        title: RULES.ECOSYSTEM_UNSUPPORTED.rule_name + ': ' + ecosystem,
        reminder: RULES.ECOSYSTEM_UNSUPPORTED.reminder + ' (' + ecosystem + ', ' + group.length + ' packages)',
      }));
      continue;
    }

    let vulnShard;
    try { vulnShard = db.loadVulnShard(dir, ecosystem, o); }
    catch (err) {
      findings.push(_coverageFinding(RULES.DB_UNVERIFIED, {
        title: RULES.DB_UNVERIFIED.rule_name + ': ' + ecosystem,
        reminder: RULES.DB_UNVERIFIED.reminder + ' (' + ecosystem + ', ' + (err && err.code) + ')',
      }));
      continue;
    }

    let malShard = null;
    try { malShard = db.loadMaliciousShard(dir, ecosystem, o); }
    catch { malShard = null; }

    if (!vulnShard && !malShard) {
      coverage.ecosystems_without_shard.push(ecosystem);
      continue;
    }
    coverage.ecosystems_checked.push(ecosystem);

    for (const pkg of group) {
      if (malShard) {
        const record = malicious.lookup(malShard, ecosystem, pkg.name);
        if (record && _maliciousHit(record, pkg.version)) {
          findings.push(_maliciousFinding(pkg, record));
        }
      }
      if (!pkg.version) {
        coverage.packages_without_version += 1;
        continue;
      }
      coverage.packages_checked += 1;
      const index = vulnShard && vulnShard.advisories;
      const advisories = index ? index[pkg.key] : null;
      if (!Array.isArray(advisories)) continue;
      for (const advisory of advisories) {
        if (_matches(ecosystem, pkg.version, advisory)) {
          findings.push(_vulnFinding(pkg, advisory));
        }
      }
    }
  }

  return { findings: finding.sortFindings(findings), coverage };
}

module.exports = { RULES, STALE_DAYS, UNRATED_SEVERITY, UNSCORED_SEVERITY, scanInventory };
