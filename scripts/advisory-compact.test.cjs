'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const compact = require('./advisory-compact.cjs');

function record(over) {
  return Object.assign({
    id: 'GHSA-xxxx-yyyy-zzzz',
    summary: 'A problem',
    affected: [{
      package: { ecosystem: 'npm', name: 'yaml' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.8.1' }] }],
    }],
  }, over || {});
}

test('COMPACT-1 the license allowlist excludes share-alike sources', () => {
  assert.ok(compact.isLicenseAllowed('CC-BY-4.0'));
  assert.ok(compact.isLicenseAllowed('CC0-1.0'));
  assert.ok(!compact.isLicenseAllowed('CC-BY-SA-4.0'));
  assert.ok(!compact.isLicenseAllowed('GPL-3.0-only'));
  assert.ok(!compact.isLicenseAllowed(''));
  assert.ok(!compact.isLicenseAllowed(null));
});

test('COMPACT-2 withdrawn advisories are dropped entirely', () => {
  assert.equal(compact.compactRecord(record({ withdrawn: '2026-01-01T00:00:00Z' })), null);
  const { stats } = compact.buildShards([record({ withdrawn: '2026-01-01T00:00:00Z' })]);
  assert.equal(stats.withdrawn, 1);
  assert.equal(stats.vuln_entries, 0);
});

test('COMPACT-3 the long details field is never carried into the snapshot', () => {
  const entries = compact.compactRecord(record({ details: 'x'.repeat(50000) }));
  assert.equal(JSON.stringify(entries).includes('xxxxx'), false);
  assert.equal('details' in entries[0].advisory, false);
  assert.equal('references' in entries[0].advisory, false);
});

test('COMPACT-4 summary is collapsed and capped', () => {
  const entries = compact.compactRecord(record({ summary: 'a\n  b\t c ' }));
  assert.equal(entries[0].advisory.summary, 'a b c');
  const long = compact.compactRecord(record({ summary: 'y'.repeat(500) }));
  assert.ok(long[0].advisory.summary.length <= compact.MAX_SUMMARY_CHARS);
});

test('COMPACT-5 severity comes from a CVSS vector when present', () => {
  const entries = compact.compactRecord(record({
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
  }));
  assert.equal(entries[0].advisory.severity, 'critical');
});

test('COMPACT-6 a numeric severity score is honoured', () => {
  const entries = compact.compactRecord(record({ severity: [{ type: 'CVSS_V3', score: 7.5 }] }));
  assert.equal(entries[0].advisory.severity, 'high');
});

test('COMPACT-7 the database label is the fallback, not the primary source', () => {
  const both = compact.compactRecord(record({
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N' }],
    database_specific: { severity: 'CRITICAL' },
  }));
  assert.equal(both[0].advisory.severity, 'medium', 'the computed vector must win over the label');

  const labelOnly = compact.compactRecord(record({ database_specific: { severity: 'MODERATE' } }));
  assert.equal(labelOnly[0].advisory.severity, 'medium');
});

test('COMPACT-8 an absent or unusable severity is unrated, never escalated', () => {
  assert.equal(compact.compactRecord(record({}))[0].advisory.severity, compact.UNRATED);
  assert.equal(
    compact.compactRecord(record({ severity: [{ score: 'garbage' }] }))[0].advisory.severity,
    compact.UNRATED,
    'malformed data is not a rating — it must not escalate to unscored',
  );
});

test('COMPACT-9 only well-formed CWE and CVE identifiers survive', () => {
  const entries = compact.compactRecord(record({
    aliases: ['CVE-2026-1234', 'GHSA-abcd-efgh-ijkl', 'not-a-cve'],
    database_specific: { cwe_ids: ['CWE-79', 'cwe-89', 'bogus', 'CWE-79'] },
  }));
  assert.deepEqual(entries[0].advisory.cve, ['CVE-2026-1234']);
  assert.deepEqual(entries[0].advisory.cwe, ['CWE-79', 'CWE-89']);
});

test('COMPACT-10 ranges keep only the three boundary event kinds', () => {
  const entries = compact.compactRecord(record({
    affected: [{
      package: { ecosystem: 'npm', name: 'yaml' },
      ranges: [{
        type: 'SEMVER',
        repo: 'https://example.test/repo',
        events: [{ introduced: '1.0.0' }, { limit: 'ignored' }, { last_affected: '1.9.9' }],
      }],
    }],
  }));
  assert.deepEqual(entries[0].advisory.ranges, [
    { events: [{ introduced: '1.0.0' }, { last_affected: '1.9.9' }] },
  ]);
});

test('COMPACT-11 package keys are normalized so lookups cannot miss', () => {
  const entries = compact.compactRecord(record({
    affected: [{
      package: { ecosystem: 'PyPI', name: 'Flask_SQLAlchemy' },
      ranges: [{ events: [{ introduced: '0' }, { fixed: '3.0.0' }] }],
    }],
  }));
  assert.equal(entries[0].key, 'flask-sqlalchemy');
  assert.equal(entries[0].ecosystem, 'PyPI');
});

test('COMPACT-12 unknown ecosystems are skipped rather than mis-sharded', () => {
  const entries = compact.compactRecord(record({
    affected: [{ package: { ecosystem: 'Alpine:v3.19', name: 'openssl' }, ranges: [{ events: [{ introduced: '0' }] }] }],
  }));
  assert.equal(entries, null);
});

test('COMPACT-13 an ecosystem suffix on a supported name is tolerated', () => {
  const entries = compact.compactRecord(record({
    affected: [{ package: { ecosystem: 'Maven:something', name: 'org.x:y' }, ranges: [{ events: [{ introduced: '0' }] }] }],
  }));
  assert.equal(entries[0].ecosystem, 'Maven');
});

test('COMPACT-14 malicious records are routed to the malicious shard, not the vuln shard', () => {
  const mal = record({ id: 'MAL-2026-0001', affected: [{ package: { ecosystem: 'npm', name: 'evil-pkg' }, versions: ['1.0.0', '1.0.1'] }] });
  const { vuln, malicious, stats } = compact.buildShards([mal]);
  assert.equal(vuln.size, 0);
  assert.equal(stats.malicious_entries, 1);
  assert.deepEqual(malicious.get('npm').get('evil-pkg'), { id: 'MAL-2026-0001', versions: '1.0.0,1.0.1' });
});

test('COMPACT-15 a malicious record without versions marks every version', () => {
  const mal = record({ id: 'MAL-2026-0002', affected: [{ package: { ecosystem: 'npm', name: 'evil2' } }] });
  const { malicious } = compact.buildShards([mal]);
  assert.equal(malicious.get('npm').get('evil2').versions, '*');
});

test('COMPACT-16 an advisory with neither ranges nor versions is skipped', () => {
  const { vuln, stats } = compact.buildShards([
    record({ affected: [{ package: { ecosystem: 'npm', name: 'yaml' } }] }),
  ]);
  assert.equal(vuln.size, 0);
  assert.equal(stats.skipped, 1);
});

test('COMPACT-17 shards are sharded per ecosystem and keyed by package', () => {
  const { vuln } = compact.buildShards([
    record({}),
    record({ id: 'GHSA-2', affected: [{ package: { ecosystem: 'PyPI', name: 'flask' }, ranges: [{ events: [{ introduced: '0' }] }] }] }),
  ]);
  assert.deepEqual([...vuln.keys()].sort(), ['PyPI', 'npm']);
  assert.deepEqual([...vuln.get('npm').keys()], ['yaml']);
});

test('COMPACT-18 two advisories for one package accumulate under one key', () => {
  const { vuln } = compact.buildShards([record({ id: 'GHSA-b' }), record({ id: 'GHSA-a' })]);
  assert.equal(vuln.get('npm').get('yaml').length, 2);
});

test('COMPACT-19 rendered vuln shard is sorted by key and by advisory id', () => {
  const { vuln } = compact.buildShards([
    record({ id: 'GHSA-b' }),
    record({ id: 'GHSA-a' }),
    record({ id: 'GHSA-c', affected: [{ package: { ecosystem: 'npm', name: 'aaa' }, ranges: [{ events: [{ introduced: '0' }] }] }] }),
  ]);
  const rendered = compact.renderVulnShard(vuln.get('npm'));
  assert.deepEqual(Object.keys(JSON.parse(rendered)), ['aaa', 'yaml']);
  assert.deepEqual(JSON.parse(rendered).yaml.map((a) => a.id), ['GHSA-a', 'GHSA-b']);
});

test('COMPACT-20 rendered malicious shard is sorted, tab-delimited, newline-terminated', () => {
  const { malicious } = compact.buildShards([
    record({ id: 'MAL-2', affected: [{ package: { ecosystem: 'npm', name: 'zeta' }, versions: ['1.0.0'] }] }),
    record({ id: 'MAL-1', affected: [{ package: { ecosystem: 'npm', name: 'alpha' }, versions: ['2.0.0'] }] }),
  ]);
  const rendered = compact.renderMaliciousShard(malicious.get('npm'));
  assert.equal(rendered, 'alpha\tMAL-1\t2.0.0\nzeta\tMAL-2\t1.0.0\n');
});

test('COMPACT-21 an empty malicious shard renders as the empty string', () => {
  assert.equal(compact.renderMaliciousShard(new Map()), '');
});

test('COMPACT-22 a key containing a delimiter is refused rather than corrupting the shard', () => {
  const poisoned = new Map([['bad\tkey', { id: 'MAL-3', versions: '*' }]]);
  assert.throws(() => compact.renderMaliciousShard(poisoned), /tab or newline/);
});

test('COMPACT-23 junk records never throw the whole build', () => {
  const { stats } = compact.buildShards([null, undefined, {}, 'x', { id: '' }, record({})]);
  assert.equal(stats.vuln_entries, 1);
  assert.ok(stats.skipped >= 4);
});

test('COMPACT-24 a GIT range never enters the shard', () => {
  const entries = compact.compactRecord(record({
    affected: [{
      package: { ecosystem: 'PyPI', name: 'lodash' },
      ranges: [
        { type: 'GIT', events: [{ introduced: '0' }, { fixed: 'ded9bc66aa6d2f0d6d0b0b0b0b0b0b0b0b0b0b0b' }] },
        { type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.17.21' }] },
      ],
    }],
  }));
  assert.equal(entries[0].advisory.ranges.length, 1, 'only the version range survives');
  assert.deepEqual(entries[0].advisory.ranges[0].events, [{ introduced: '0' }, { fixed: '4.17.21' }]);
  assert.ok(!JSON.stringify(entries[0]).includes('ded9bc66'), 'no commit sha reaches the shard');
});

test('COMPACT-25 a GIT-only advisory is dropped rather than stored unmatchable', () => {
  const built = compact.buildShards([record({
    affected: [{
      package: { ecosystem: 'PyPI', name: 'x' },
      ranges: [{ type: 'GIT', events: [{ introduced: '0' }, { fixed: 'a'.repeat(40) }] }],
    }],
  })]);
  assert.equal(built.vuln.size, 0);
  assert.equal(built.stats.skipped, 1);
});

test('COMPACT-26 a SEMVER range and an untyped range are both kept', () => {
  for (const type of ['SEMVER', 'ECOSYSTEM', undefined]) {
    const entries = compact.compactRecord(record({
      affected: [{ package: { ecosystem: 'npm', name: 'y' }, ranges: [{ type, events: [{ introduced: '0' }, { fixed: '1.0.0' }] }] }],
    }));
    assert.equal(entries[0].advisory.ranges.length, 1, 'type: ' + String(type));
  }
});

test('COMPACT-27 a versions-only advisory carries its versions so it can match', () => {
  const entries = compact.compactRecord(record({
    affected: [{ package: { ecosystem: 'npm', name: 'z' }, versions: ['1.0.0', '1.0.1'] }],
  }));
  assert.deepEqual(entries[0].advisory.versions, ['1.0.0', '1.0.1']);
  assert.deepEqual(entries[0].advisory.ranges, []);
});

test('COMPACT-28 a range-bearing advisory carries no redundant versions list', () => {
  const entries = compact.compactRecord(record({
    affected: [{ package: { ecosystem: 'npm', name: 'z' }, versions: ['1.0.0'], ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }],
  }));
  assert.deepEqual(entries[0].advisory.versions, []);
  assert.equal(entries[0].advisory.ranges.length, 1);
});

test('COMPACT-29 an advisory rated with a vector we cannot score is unscored, not unrated', () => {
  const v4 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N';
  const entries = compact.compactRecord(record({ severity: [{ type: 'CVSS_V4', score: v4 }] }));
  assert.equal(entries[0].advisory.severity, compact.UNSCORED,
    'a present-but-unparseable vector must not be confused with no rating at all');
});

test('COMPACT-30 an advisory with no severity information at all is unrated', () => {
  assert.equal(compact.compactRecord(record({}))[0].advisory.severity, compact.UNRATED);
  assert.equal(compact.compactRecord(record({ severity: [] }))[0].advisory.severity, compact.UNRATED);
});

test('COMPACT-31 a database label still wins over an unscoreable vector', () => {
  const v4 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N';
  const entries = compact.compactRecord(record({
    severity: [{ type: 'CVSS_V4', score: v4 }],
    database_specific: { severity: 'CRITICAL' },
  }));
  assert.equal(entries[0].advisory.severity, 'critical');
});
