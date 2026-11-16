'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const build = require('./build-advisory-db.cjs');

function zipOf(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const raw = Buffer.from(text, 'utf-8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + deflated.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

function advisory(id, eco, name, fixed) {
  return JSON.stringify({
    id,
    summary: 'problem in ' + name,
    details: 'x'.repeat(3000),
    references: [{ type: 'WEB', url: 'https://example.test' }],
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    database_specific: { cwe_ids: ['CWE-79'] },
    affected: [{ package: { ecosystem: eco, name }, ranges: [{ events: [{ introduced: '0' }, { fixed }] }] }],
  });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-advdb-'));
}

const TS = '2026-08-03T00:00:00.000Z';

test('BUILD-1 every shipped feed carries an allowlisted license', () => {
  assert.doesNotThrow(() => build.assertFeedLicenses(build.FEEDS));
  assert.ok(build.FEEDS.length > 0);
});

test('BUILD-2 a feed with a share-alike license is refused, not silently included', () => {
  assert.throws(
    () => build.assertFeedLicenses([{ eco: 'npm', url: 'https://x', license: 'CC-BY-SA-4.0' }]),
    /not on the redistribution allowlist/,
  );
});

test('BUILD-3 records are extracted from a zip archive', () => {
  const zip = zipOf({
    'GHSA-1.json': advisory('GHSA-1', 'npm', 'yaml', '2.8.1'),
    'GHSA-2.json': advisory('GHSA-2', 'npm', 'lodash', '4.17.21'),
    'README.txt': 'not an advisory',
  });
  const { records, malformed } = build.recordsFromArchive(zip);
  assert.equal(records.length, 2);
  assert.equal(malformed, 0);
  assert.deepEqual(records.map((r) => r.id).sort(), ['GHSA-1', 'GHSA-2']);
});

test('BUILD-4 a malformed json entry is counted, not fatal', () => {
  const zip = zipOf({ 'ok.json': advisory('GHSA-1', 'npm', 'yaml', '2.8.1'), 'bad.json': '{ not json' });
  const { records, malformed } = build.recordsFromArchive(zip);
  assert.equal(records.length, 1);
  assert.equal(malformed, 1);
});

test('BUILD-5 build writes per-ecosystem shards plus a manifest', async () => {
  const dir = tmpdir();
  try {
    const feeds = [
      { eco: 'npm', url: 'https://feed/npm', license: 'CC-BY-4.0' },
      { eco: 'PyPI', url: 'https://feed/pypi', license: 'CC-BY-4.0' },
    ];
    const archives = {
      'https://feed/npm': zipOf({ 'a.json': advisory('GHSA-1', 'npm', 'yaml', '2.8.1') }),
      'https://feed/pypi': zipOf({ 'b.json': advisory('GHSA-2', 'PyPI', 'Flask_SQLAlchemy', '3.0.0') }),
    };
    const result = await build.build({
      feeds, outDir: dir, generatedAt: TS, toolVersion: '1.5.0',
      fetchImpl: async (url) => archives[url],
    });
    assert.equal(result.manifest.generated_at, TS);
    assert.deepEqual(Object.keys(result.manifest.ecosystems).sort(), ['PyPI', 'npm']);
    assert.ok(fs.existsSync(path.join(dir, 'vuln-npm.json.gz')));
    assert.ok(fs.existsSync(path.join(dir, 'vuln-PyPI.json.gz')));
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-6 shard content is gzipped, keyed by normalized name, and details-free', async () => {
  const dir = tmpdir();
  try {
    const result = await build.build({
      feeds: [{ eco: 'PyPI', url: 'u', license: 'CC-BY-4.0' }],
      outDir: dir, generatedAt: TS,
      fetchImpl: async () => zipOf({ 'a.json': advisory('GHSA-1', 'PyPI', 'Flask_SQLAlchemy', '3.0.0') }),
    });
    assert.ok(result.manifest.sha256['vuln-PyPI.json.gz']);
    const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'vuln-PyPI.json.gz'))).toString('utf-8'));
    assert.deepEqual(Object.keys(shard), ['flask-sqlalchemy']);
    assert.equal(shard['flask-sqlalchemy'][0].severity, 'critical');
    assert.deepEqual(shard['flask-sqlalchemy'][0].cwe, ['CWE-79']);
    assert.ok(!JSON.stringify(shard).includes('xxxxx'), 'details must not be shipped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-7 malicious records go to their own sorted text shard', async () => {
  const dir = tmpdir();
  try {
    const mal = JSON.stringify({
      id: 'MAL-2026-00001',
      affected: [{ package: { ecosystem: 'npm', name: 'evil-pkg' }, versions: ['1.0.0'] }],
    });
    await build.build({
      feeds: [{ eco: 'npm', url: 'u', license: 'CC-BY-4.0' }],
      outDir: dir, generatedAt: TS,
      fetchImpl: async () => zipOf({ 'm.json': mal }),
    });
    const body = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'malicious-npm.txt.gz'))).toString('utf-8');
    assert.equal(body, 'evil-pkg\tMAL-2026-00001\t1.0.0\n');
    assert.ok(!fs.existsSync(path.join(dir, 'vuln-npm.json.gz')), 'a MAL record must not land in the vuln shard');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-8 the manifest records source licenses for attribution', async () => {
  const dir = tmpdir();
  try {
    const result = await build.build({
      feeds: [{ eco: 'crates.io', url: 'u', license: 'CC0-1.0' }],
      outDir: dir, generatedAt: TS,
      fetchImpl: async () => zipOf({ 'a.json': advisory('RUSTSEC-1', 'crates.io', 'serde', '1.0.198') }),
    });
    assert.deepEqual(result.manifest.sources, [{ name: 'crates.io', license: 'CC0-1.0' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-9 an ecosystem name containing a dot survives the filename round trip', async () => {
  const dir = tmpdir();
  try {
    await build.build({
      feeds: [{ eco: 'crates.io', url: 'u', license: 'CC0-1.0' }],
      outDir: dir, generatedAt: TS,
      fetchImpl: async () => zipOf({ 'a.json': advisory('RUSTSEC-1', 'crates.io', 'serde', '1.0.198') }),
    });
    assert.ok(fs.existsSync(path.join(dir, 'vuln-crates.io.json.gz')));
    assert.equal(build.verifyOnDisk(dir).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-10 verifyOnDisk passes on a freshly written store', async () => {
  const dir = tmpdir();
  try {
    await build.build({
      feeds: [{ eco: 'npm', url: 'u', license: 'CC-BY-4.0' }],
      outDir: dir, generatedAt: TS,
      fetchImpl: async () => zipOf({ 'a.json': advisory('GHSA-1', 'npm', 'yaml', '2.8.1') }),
    });
    const result = build.verifyOnDisk(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual(result.missing, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-11 a single flipped byte in a shard is detected', async () => {
  const dir = tmpdir();
  try {
    await build.build({
      feeds: [{ eco: 'npm', url: 'u', license: 'CC-BY-4.0' }],
      outDir: dir, generatedAt: TS,
      fetchImpl: async () => zipOf({ 'a.json': advisory('GHSA-1', 'npm', 'yaml', '2.8.1') }),
    });
    const target = path.join(dir, 'vuln-npm.json.gz');
    const body = fs.readFileSync(target);
    body[body.length - 1] ^= 0xff;
    fs.writeFileSync(target, body);

    const result = build.verifyOnDisk(dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ['vuln-npm.json.gz']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-12 a deleted shard is reported as missing, not as ok', async () => {
  const dir = tmpdir();
  try {
    await build.build({
      feeds: [{ eco: 'npm', url: 'u', license: 'CC-BY-4.0' }],
      outDir: dir, generatedAt: TS,
      fetchImpl: async () => zipOf({ 'a.json': advisory('GHSA-1', 'npm', 'yaml', '2.8.1') }),
    });
    fs.unlinkSync(path.join(dir, 'vuln-npm.json.gz'));
    const result = build.verifyOnDisk(dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['vuln-npm.json.gz']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-13 verifyOnDisk on an absent store reports the reason instead of throwing', () => {
  const dir = tmpdir();
  try {
    const result = build.verifyOnDisk(dir);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest-unreadable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-14 the same input twice produces byte-identical shards', async () => {
  const a = tmpdir();
  const b = tmpdir();
  try {
    const opts = {
      feeds: [{ eco: 'npm', url: 'u', license: 'CC-BY-4.0' }],
      generatedAt: TS,
      fetchImpl: async () => zipOf({ 'a.json': advisory('GHSA-1', 'npm', 'yaml', '2.8.1') }),
    };
    const r1 = await build.build({ ...opts, outDir: a });
    const r2 = await build.build({ ...opts, outDir: b });
    assert.deepEqual(r1.manifest.sha256, r2.manifest.sha256);
    assert.deepEqual(
      fs.readFileSync(path.join(a, 'vuln-npm.json.gz')),
      fs.readFileSync(path.join(b, 'vuln-npm.json.gz')),
    );
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('BUILD-15 a fetch failure is refused rather than written as an empty shard', async () => {
  const dir = tmpdir();
  try {
    await assert.rejects(
      build.build({
        feeds: [{ eco: 'npm', url: 'u', license: 'CC-BY-4.0' }],
        outDir: dir, generatedAt: TS,
        fetchImpl: async () => { throw new Error('boom'); },
      }),
      (err) => {
        assert.equal(err.code, 'advisory-build-all-feeds-failed');
        assert.deepEqual(err.details.failed.map((f) => f.reason), ['boom'],
          'the underlying reason must survive into the error details');
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-16 one failing feed does not silently produce a partial snapshot', async () => {
  const dir = tmpdir();
  try {
    await assert.rejects(
      build.build({
        feeds: [
          { eco: 'npm', url: 'u1', license: 'CC-BY-4.0' },
          { eco: 'PyPI', url: 'u2', license: 'CC-BY-4.0' },
        ],
        outDir: dir, generatedAt: TS,
        fetchImpl: async (url) => {
          if (url === 'u1') throw Object.assign(new Error('boom'), { code: 'zip-zip64-unsupported' });
          return zipOf({ 'a.json': advisory('GHSA-2', 'PyPI', 'flask', '3.0.0') });
        },
      }),
      (err) => {
        assert.equal(err.code, 'advisory-build-feed-failed');
        assert.match(err.message, /npm \(zip-zip64-unsupported\)/);
        return true;
      },
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-17 a partial snapshot is possible but only when asked for explicitly', async () => {
  const dir = tmpdir();
  try {
    const result = await build.build({
      feeds: [
        { eco: 'npm', url: 'u1', license: 'CC-BY-4.0' },
        { eco: 'PyPI', url: 'u2', license: 'CC-BY-4.0' },
      ],
      outDir: dir, generatedAt: TS, requireAllFeeds: false,
      fetchImpl: async (url) => {
        if (url === 'u1') throw new Error('boom');
        return zipOf({ 'a.json': advisory('GHSA-2', 'PyPI', 'flask', '3.0.0') });
      },
    });
    assert.deepEqual(result.failed.map((f) => f.eco), ['npm']);
    assert.ok(fs.existsSync(path.join(dir, 'vuln-PyPI.json.gz')));
    assert.deepEqual(result.manifest.sources.map((s) => s.name), ['PyPI'],
      'a feed that failed must not be attributed as a source');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUILD-18 every feed failing refuses to write an empty snapshot', async () => {
  const dir = tmpdir();
  try {
    await assert.rejects(
      build.build({
        feeds: [{ eco: 'npm', url: 'u1', license: 'CC-BY-4.0' }],
        outDir: dir, generatedAt: TS, requireAllFeeds: false,
        fetchImpl: async () => { throw new Error('boom'); },
      }),
      (err) => { assert.equal(err.code, 'advisory-build-all-feeds-failed'); return true; },
    );
    assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
