'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const advisory = require('./index.cjs');
const finding = require('../finding.cjs');
const db = require('./db.cjs');
const compact = require('../../../scripts/advisory-compact.cjs');
const builder = require('../../../scripts/build-advisory-db.cjs');
const { makePackage } = require('../inventory/pkgurl.cjs');

const TS = '2026-08-01T00:00:00.000Z';
const NOW = Date.parse('2026-08-03T00:00:00.000Z');

function store(records, generatedAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-adv-'));
  const built = compact.buildShards(records);
  builder.writeShards(dir, built, {
    generatedAt: generatedAt || TS,
    toolVersion: '1.5.0',
    feeds: [{ eco: 'npm', license: 'CC-BY-4.0' }],
  });
  db._clearCache();
  return dir;
}

function vulnRecord(name, introduced, fixed, over) {
  return Object.assign({
    id: 'GHSA-test-0001',
    summary: 'a flaw in ' + name,
    aliases: ['CVE-2026-1111'],
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    database_specific: { cwe_ids: ['CWE-79'] },
    affected: [{
      package: { ecosystem: 'npm', name },
      ranges: [{ events: [{ introduced }, { fixed }] }],
    }],
  }, over || {});
}

function malRecord(name, versions) {
  return {
    id: 'MAL-2026-00042',
    affected: [{ package: { ecosystem: 'npm', name }, versions }],
  };
}

function inv(packages) {
  return { packages };
}

function pkg(name, version, over) {
  return makePackage(Object.assign({ ecosystem: 'npm', name, version, source: 'package-lock.json' }, over || {}));
}

test('ADV-1 a vulnerable version inside the range is reported with its fix', () => {
  const dir = store([vulnRecord('yaml', '2.0.0', '2.8.1')]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir, now: NOW });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'NPS-0300');
    assert.equal(findings[0].severity, 'critical');
    assert.equal(findings[0].fixed_version, '2.8.1');
    assert.deepEqual(findings[0].cwe, ['CWE-79']);
    assert.equal(findings[0].package.name, 'yaml');
    assert.equal(findings[0].file, 'package-lock.json');
    assert.match(findings[0].title, /^CVE-2026-1111/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-2 the fixed version itself is not reported', () => {
  const dir = store([vulnRecord('yaml', '2.0.0', '2.8.1')]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('yaml', '2.8.1')]), { dir, now: NOW });
    assert.deepEqual(findings, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-3 a version below the introduced boundary is not reported', () => {
  const dir = store([vulnRecord('yaml', '2.0.0', '2.8.1')]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('yaml', '1.9.0')]), { dir, now: NOW });
    assert.deepEqual(findings, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-4 an unrelated package produces nothing', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')]);
  try {
    const { findings, coverage } = advisory.scanInventory(inv([pkg('lodash', '4.17.21')]), { dir, now: NOW });
    assert.deepEqual(findings, []);
    assert.equal(coverage.packages_checked, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-5 a normalized name still finds its advisory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-adv-'));
  try {
    const built = compact.buildShards([{
      id: 'GHSA-py',
      summary: 'flask flaw',
      affected: [{ package: { ecosystem: 'PyPI', name: 'Flask_SQLAlchemy' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '3.0.0' }] }] }],
    }]);
    builder.writeShards(dir, built, { generatedAt: TS, toolVersion: '1.5.0', feeds: [{ eco: 'PyPI', license: 'CC-BY-4.0' }] });
    db._clearCache();
    const target = makePackage({ ecosystem: 'PyPI', name: 'flask-sqlalchemy', version: '2.5.1', source: 'requirements.txt' });
    const { findings } = advisory.scanInventory(inv([target]), { dir, now: NOW });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fixed_version, '3.0.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-6 a malicious package version is reported as critical', () => {
  const dir = store([malRecord('evil-pkg', ['1.0.0'])]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('evil-pkg', '1.0.0')]), { dir, now: NOW });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'NPS-0400');
    assert.equal(findings[0].severity, 'critical');
    assert.deepEqual(findings[0].cwe, ['CWE-506']);
    assert.match(findings[0].reminder, /rotate any credentials/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-7 a different version of a malicious package is not reported', () => {
  const dir = store([malRecord('evil-pkg', ['1.0.0'])]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('evil-pkg', '2.0.0')]), { dir, now: NOW });
    assert.deepEqual(findings, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-8 a malicious record without versions condemns every version', () => {
  const dir = store([malRecord('evil-all', undefined)]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('evil-all', '9.9.9')]), { dir, now: NOW });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'NPS-0400');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-9 an absent database reports a coverage gap instead of a clean result', () => {
  const { findings, coverage } = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir: null, now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'NPS-0301');
  assert.equal(coverage.db_present, false);
  assert.equal(coverage.packages_checked, 0);
});

test('ADV-10 an empty directory reports the same coverage gap, not silence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-adv-empty-'));
  try {
    const { findings } = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir, now: NOW });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'NPS-0301');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-11 a tampered shard refuses to answer rather than reporting clean', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')]);
  try {
    const target = path.join(dir, 'vuln-npm.json.gz');
    const body = fs.readFileSync(target);
    body[body.length - 1] ^= 0xff;
    fs.writeFileSync(target, body);
    db._clearCache();

    const { findings } = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir, now: NOW });
    assert.ok(findings.some((f) => f.id === 'NPS-0302'), 'integrity failure must surface');
    assert.ok(!findings.some((f) => f.id === 'NPS-0300'), 'no vulnerability verdict may come from a tampered shard');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-12 a package without a version is counted, never silently matched', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')]);
  try {
    const { findings, coverage } = advisory.scanInventory(inv([pkg('yaml', null)]), { dir, now: NOW });
    assert.deepEqual(findings, []);
    assert.equal(coverage.packages_without_version, 1);
    assert.equal(coverage.packages_checked, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-13 coverage reports the snapshot age from an injected clock', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')], '2026-07-04T00:00:00.000Z');
  try {
    const { coverage } = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir, now: NOW });
    assert.equal(coverage.age_days, 30);
    assert.equal(coverage.stale, false);
    assert.equal(coverage.generated_at, '2026-07-04T00:00:00.000Z');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-14 a snapshot older than the stale threshold is flagged', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')], '2026-01-01T00:00:00.000Z');
  try {
    const { coverage } = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir, now: NOW });
    assert.ok(coverage.age_days > advisory.STALE_DAYS);
    assert.equal(coverage.stale, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-15 an ecosystem with no shard is recorded as unchecked, not as clean', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')]);
  try {
    const rust = makePackage({ ecosystem: 'crates.io', name: 'serde', version: '1.0.0', source: 'Cargo.lock' });
    const { coverage } = advisory.scanInventory(inv([pkg('yaml', '9.9.9'), rust]), { dir, now: NOW });
    assert.deepEqual(coverage.ecosystems_checked, ['npm']);
    assert.deepEqual(coverage.ecosystems_without_shard, ['crates.io']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-16 two advisories for one package both surface', () => {
  const dir = store([
    vulnRecord('yaml', '0', '2.8.1'),
    vulnRecord('yaml', '0', '2.9.0', { id: 'GHSA-test-0002', aliases: ['CVE-2026-2222'] }),
  ]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir, now: NOW });
    assert.equal(findings.length, 2);
    assert.equal(new Set(findings.map((f) => f.fixed_version)).size, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-17 findings come back severity-sorted', () => {
  const dir = store([
    vulnRecord('low-pkg', '0', '2.0.0', { id: 'GHSA-low', severity: [{ score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N' }] }),
    malRecord('evil-pkg', ['1.0.0']),
  ]);
  try {
    const { findings } = advisory.scanInventory(
      inv([pkg('low-pkg', '1.0.0'), pkg('evil-pkg', '1.0.0')]),
      { dir, now: NOW },
    );
    assert.equal(findings[0].severity, 'critical');
    assert.equal(findings[0].id, 'NPS-0400');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-18 an empty inventory yields no findings and an honest coverage report', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')]);
  try {
    const { findings, coverage } = advisory.scanInventory(inv([]), { dir, now: NOW });
    assert.deepEqual(findings, []);
    assert.equal(coverage.db_present, true);
    assert.equal(coverage.packages_total, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-19 every rule id sits in its declared range and is unique', () => {
  const seen = new Set();
  for (const rule of Object.values(advisory.RULES)) {
    const scanner = rule.id.startsWith('NPS-04') ? 'malicious' : 'advisory';
    assert.ok(finding.idInRange(rule.id, scanner), rule.id + ' outside the ' + scanner + ' range');
    assert.ok(!seen.has(rule.id), 'duplicate ' + rule.id);
    seen.add(rule.id);
  }
});


test('ADV-20 an advisory whose only range was GIT-typed cannot crash the scan', () => {
  const dir = store([vulnRecord('yaml', '0', '2.8.1')]);
  try {
    const poisoned = { ranges: [{ events: [{ introduced: '0' }, { fixed: 'not-a-version' }] }], id: 'X', cve: [], cwe: [], severity: 'high', summary: 's' };
    const shardPath = path.join(dir, 'vuln-npm.json.gz');
    const zlib = require('node:zlib');
    const body = JSON.parse(zlib.gunzipSync(fs.readFileSync(shardPath)).toString('utf-8'));
    body.yaml = [poisoned];
    fs.writeFileSync(shardPath, zlib.gzipSync(Buffer.from(JSON.stringify(body), 'utf-8')));
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.sha256['vuln-npm.json.gz'] = require('node:crypto')
      .createHash('sha256').update(fs.readFileSync(shardPath)).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    db._clearCache();

    const result = advisory.scanInventory(inv([pkg('yaml', '2.5.0')]), { dir, now: NOW });
    assert.ok(Array.isArray(result.findings), 'an unparseable boundary must not propagate out of scanInventory');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-21 a versions-only advisory matches the listed version', () => {
  const dir = store([{
    id: 'GHSA-versions-only',
    summary: 'listed versions only',
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [{ package: { ecosystem: 'npm', name: 'evilpkg' }, versions: ['1.0.0', '1.0.1'] }],
  }]);
  try {
    const hit = advisory.scanInventory(inv([pkg('evilpkg', '1.0.1')]), { dir, now: NOW });
    assert.ok(hit.findings.some((f) => f.id === 'NPS-0300'), 'the listed version must be reported');
    const miss = advisory.scanInventory(inv([pkg('evilpkg', '2.0.0')]), { dir, now: NOW });
    assert.ok(!miss.findings.some((f) => f.id === 'NPS-0300'), 'an unlisted version must not be reported');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-22 a go-style v-prefixed version still matches a malicious record', () => {
  const dir = store([malRecord('github.com/evil/backdoor', ['1.2.3'])]);
  try {
    const goPkg = makePackage({ ecosystem: 'npm', name: 'github.com/evil/backdoor', version: 'v1.2.3', source: 'go.mod' });
    const { findings } = advisory.scanInventory(inv([goPkg]), { dir, now: NOW });
    assert.ok(findings.some((f) => f.id === 'NPS-0400'), 'v1.2.3 must match the recorded 1.2.3');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-23 an unrelated version is still not a malicious hit after normalization', () => {
  const dir = store([malRecord('evil-pkg', ['1.2.3'])]);
  try {
    const { findings } = advisory.scanInventory(inv([pkg('evil-pkg', 'v9.9.9')]), { dir, now: NOW });
    assert.ok(!findings.some((f) => f.id === 'NPS-0400'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADV-24 an unscoreable vector fails safe upward, an unrated advisory does not', () => {
  const v4 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N';
  const unscored = store([{
    id: 'GHSA-v4', summary: 'v4 only',
    severity: [{ type: 'CVSS_V4', score: v4 }],
    affected: [{ package: { ecosystem: 'npm', name: 'a' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }],
  }]);
  try {
    const f = advisory.scanInventory(inv([pkg('a', '1.0.0')]), { dir: unscored, now: NOW }).findings[0];
    assert.equal(f.severity, advisory.UNSCORED_SEVERITY);
    assert.equal(f.severity, 'high', 'a rated advisory we cannot score must still gate at the default');
  } finally { fs.rmSync(unscored, { recursive: true, force: true }); }

  const unrated = store([{
    id: 'GHSA-none', summary: 'no severity',
    affected: [{ package: { ecosystem: 'npm', name: 'b' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }],
  }]);
  try {
    const f = advisory.scanInventory(inv([pkg('b', '1.0.0')]), { dir: unrated, now: NOW }).findings[0];
    assert.equal(f.severity, advisory.UNRATED_SEVERITY);
    assert.equal(f.severity, 'medium', 'a genuinely unrated advisory is reported without gating');
  } finally { fs.rmSync(unrated, { recursive: true, force: true }); }
});
