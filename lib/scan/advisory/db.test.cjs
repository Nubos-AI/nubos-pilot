'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const db = require('./db.cjs');

const PACKAGED_DIR = path.join(__dirname, '..', 'data');
const GENERATED_AT = '2026-07-01T00:00:00.000Z';

function gzip(text) {
  return zlib.gzipSync(Buffer.from(text, 'utf-8'));
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function defaultFiles() {
  return {
    'vuln-npm.json.gz': gzip(JSON.stringify({
      lodash: [{
        id: 'GHSA-npm-lodash',
        cve: ['CVE-2021-23337'],
        ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
        severity: 'high',
        cwe: ['CWE-77'],
        summary: 'command injection in template',
      }],
    })),
    'vuln-PyPI.json.gz': gzip(JSON.stringify({
      'flask-sqlalchemy': [{
        id: 'GHSA-pypi-flask',
        cve: [],
        ranges: [{ events: [{ introduced: '0' }, { fixed: '2.5.1' }] }],
        severity: 'medium',
        cwe: ['CWE-400'],
        summary: 'denial of service',
      }],
    })),
    'malicious-npm.txt.gz': gzip('evil-pkg\tMAL-0001\t*\n'),
  };
}

function buildStore(options) {
  const o = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-db-'));
  const files = o.files || defaultFiles();
  const sha256 = {};
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), bytes);
    sha256[name] = digest(bytes);
  }
  const manifest = {
    schema_version: 1,
    generated_at: o.generated_at || GENERATED_AT,
    tool_version: '1.5.0',
    ecosystems: {
      npm: { advisories: 1, malicious: 1 },
      PyPI: { advisories: 1, malicious: 0 },
    },
    sources: [{ name: 'OSV', license: 'CC-BY-4.0' }],
    sha256,
    ...(o.patch || {}),
  };
  const body = o.rawManifest !== undefined ? o.rawManifest : JSON.stringify(manifest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), body);
  db._clearCache();
  return dir;
}

function flipByte(file) {
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
  fs.writeFileSync(file, bytes);
}

function withoutEnv(fn) {
  const saved = process.env[db.ENV_DB_DIR];
  delete process.env[db.ENV_DB_DIR];
  try { return fn(); }
  finally {
    if (saved === undefined) delete process.env[db.ENV_DB_DIR];
    else process.env[db.ENV_DB_DIR] = saved;
  }
}

test('DB-1 resolveDbDir prefers an explicit dir over the environment variable', () => {
  const explicit = buildStore();
  const fromEnv = buildStore();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-home-'));
  try {
    process.env[db.ENV_DB_DIR] = fromEnv;
    assert.equal(db.resolveDbDir({ dir: explicit, homedir: home }), explicit);
  } finally {
    delete process.env[db.ENV_DB_DIR];
    fs.rmSync(explicit, { recursive: true, force: true });
    fs.rmSync(fromEnv, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('DB-2 resolveDbDir falls back to the environment variable, then the versioned home dir', () => {
  const fromEnv = buildStore();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-home-'));
  const versioned = path.join(home, '.nubos-pilot', 'advisory-db', '1.5.0');
  fs.mkdirSync(versioned, { recursive: true });
  try {
    process.env[db.ENV_DB_DIR] = fromEnv;
    assert.equal(db.resolveDbDir({ homedir: home, version: '1.5.0' }), fromEnv);
    withoutEnv(() => {
      assert.equal(db.resolveDbDir({ homedir: home, version: '1.5.0' }), versioned);
      assert.equal(db.resolveDbDir({ dir: path.join(home, 'absent'), homedir: home, version: '1.5.0' }), versioned);
    });
  } finally {
    delete process.env[db.ENV_DB_DIR];
    fs.rmSync(fromEnv, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('DB-3 resolveDbDir returns null instead of throwing when nothing exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-home-'));
  try {
    withoutEnv(() => {
      const resolved = db.resolveDbDir({ dir: path.join(home, 'absent'), homedir: home, version: '1.5.0' });
      if (fs.existsSync(PACKAGED_DIR)) assert.equal(resolved, PACKAGED_DIR);
      else assert.equal(resolved, null);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('DB-4 loadManifest returns the validated shape of an intact store', () => {
  const dir = buildStore();
  try {
    const manifest = db.loadManifest(dir);
    assert.equal(manifest.schema_version, db.SCHEMA_VERSION);
    assert.equal(manifest.generated_at, GENERATED_AT);
    assert.equal(manifest.tool_version, '1.5.0');
    assert.deepEqual(Object.keys(manifest.ecosystems).sort(), ['PyPI', 'npm']);
    assert.deepEqual(manifest.sources, [{ name: 'OSV', license: 'CC-BY-4.0' }]);
    assert.equal(manifest.sha256['vuln-npm.json.gz'].length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-5 loadManifest returns null for a missing dir or missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-empty-'));
  try {
    assert.equal(db.loadManifest(path.join(dir, 'absent')), null);
    assert.equal(db.loadManifest(dir), null);
    assert.equal(db.loadManifest(null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-6 a malformed manifest throws advisory-manifest-invalid', () => {
  const broken = buildStore({ rawManifest: '{ not json' });
  const missingHashes = buildStore({ patch: { sha256: 'nope' } });
  const badEcosystem = buildStore({ patch: { ecosystems: { Fortran: { advisories: 1, malicious: 0 } } } });
  try {
    for (const dir of [broken, missingHashes, badEcosystem]) {
      assert.throws(() => db.loadManifest(dir), (err) => {
        assert.equal(err.code, 'advisory-manifest-invalid');
        return true;
      }, dir);
    }
  } finally {
    for (const dir of [broken, missingHashes, badEcosystem]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-7 an unsupported schema_version throws advisory-schema-mismatch', () => {
  const dir = buildStore({ patch: { schema_version: 99 } });
  try {
    assert.throws(() => db.loadManifest(dir), (err) => {
      assert.equal(err.code, 'advisory-schema-mismatch');
      assert.equal(err.details.found, 99);
      assert.equal(err.details.supported, db.SCHEMA_VERSION);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-8 verifyIntegrity reports ok on an intact store', () => {
  const dir = buildStore();
  try {
    const result = db.verifyIntegrity(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual(result.missing, []);
    assert.equal(result.checked.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-9 verifyIntegrity names a tampered shard', () => {
  const dir = buildStore();
  try {
    flipByte(path.join(dir, 'vuln-npm.json.gz'));
    const result = db.verifyIntegrity(dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ['vuln-npm.json.gz']);
    assert.deepEqual(result.missing, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-10 verifyIntegrity is honest about a shard it could not read', () => {
  const dir = buildStore();
  try {
    fs.rmSync(path.join(dir, 'vuln-PyPI.json.gz'));
    const result = db.verifyIntegrity(dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['vuln-PyPI.json.gz']);
    assert.deepEqual(result.mismatches, []);
    assert.ok(!result.checked.includes('vuln-PyPI.json.gz'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-11 loadVulnShard gunzips and parses a single ecosystem shard', () => {
  const dir = buildStore();
  try {
    const shard = db.loadVulnShard(dir, 'npm');
    assert.equal(shard.ecosystem, 'npm');
    assert.equal(shard.file, 'vuln-npm.json.gz');
    assert.equal(shard.packages, 1);
    assert.equal(shard.advisories.lodash[0].id, 'GHSA-npm-lodash');
    assert.deepEqual(shard.advisories.lodash[0].cve, ['CVE-2021-23337']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-12 loadVulnShard checks the digest before it trusts the bytes', () => {
  const flipped = buildStore();
  const files = defaultFiles();
  const sha256 = {};
  for (const [name, bytes] of Object.entries(files)) sha256[name] = digest(bytes);
  sha256['vuln-npm.json.gz'] = 'a'.repeat(64);
  const relabelled = buildStore({ files, patch: { sha256 } });
  try {
    flipByte(path.join(flipped, 'vuln-npm.json.gz'));
    assert.throws(() => db.loadVulnShard(flipped, 'npm'), (err) => {
      assert.equal(err.code, 'advisory-shard-tampered');
      assert.equal(err.details.file, 'vuln-npm.json.gz');
      assert.notEqual(err.details.actual, err.details.expected);
      return true;
    });
    db._clearCache();
    assert.throws(() => db.loadVulnShard(relabelled, 'npm'), (err) => {
      assert.equal(err.code, 'advisory-shard-tampered');
      return true;
    });
    db._clearCache();
    assert.equal(db.loadVulnShard(relabelled, 'npm', { skipIntegrity: true }).packages, 1);
  } finally {
    fs.rmSync(flipped, { recursive: true, force: true });
    fs.rmSync(relabelled, { recursive: true, force: true });
  }
});

test('DB-13 an absent shard is a coverage gap, not an error', () => {
  const dir = buildStore();
  try {
    assert.equal(db.loadVulnShard(dir, 'Go'), null);
    assert.equal(db.loadMaliciousShard(dir, 'PyPI'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-14 corrupt gzip throws advisory-shard-corrupt even when the digest matches', () => {
  const files = defaultFiles();
  files['vuln-npm.json.gz'] = Buffer.from('this is not gzip', 'utf-8');
  const dir = buildStore({ files });
  try {
    assert.equal(db.verifyIntegrity(dir).ok, true);
    assert.throws(() => db.loadVulnShard(dir, 'npm'), (err) => {
      assert.equal(err.code, 'advisory-shard-corrupt');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-15 a shard listed nowhere in the manifest is not silently trusted', () => {
  const dir = buildStore({ patch: { sha256: { 'malicious-npm.txt.gz': digest(defaultFiles()['malicious-npm.txt.gz']) } } });
  try {
    assert.throws(() => db.loadVulnShard(dir, 'npm'), (err) => {
      assert.equal(err.code, 'advisory-shard-unverified');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-16 the shard cache gunzips once per dir and ecosystem', () => {
  const dir = buildStore();
  try {
    const before = db._stats.gunzips;
    const first = db.loadVulnShard(dir, 'npm');
    const second = db.loadVulnShard(dir, 'npm');
    assert.equal(db._stats.gunzips - before, 1);
    assert.equal(first, second);

    const beforeMissing = db._stats.reads;
    assert.equal(db.loadVulnShard(dir, 'Go'), null);
    assert.equal(db.loadVulnShard(dir, 'Go'), null);
    assert.equal(db._stats.reads, beforeMissing);

    db._clearCache();
    db.loadVulnShard(dir, 'npm');
    assert.equal(db._stats.gunzips - before, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-17 loading the npm shard never touches the PyPI shard', () => {
  const dir = buildStore();
  const realReadFileSync = fs.readFileSync;
  const touched = [];
  try {
    fs.readFileSync = function readFileSync(file, ...rest) {
      touched.push(String(file));
      return realReadFileSync.call(fs, file, ...rest);
    };
    const shard = db.loadVulnShard(dir, 'npm');
    assert.equal(shard.packages, 1);
    assert.ok(touched.some((f) => f.endsWith('vuln-npm.json.gz')), 'npm shard was read');
    assert.deepEqual(touched.filter((f) => f.includes('PyPI')), [], 'PyPI shard must stay closed');
    assert.deepEqual(touched.filter((f) => f.includes('malicious')), [], 'malicious shard must stay closed');
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-18 loadMaliciousShard keeps the shard whole for binary search', () => {
  const dir = buildStore();
  try {
    const shard = db.loadMaliciousShard(dir, 'npm');
    assert.equal(shard.ecosystem, 'npm');
    assert.ok(Buffer.isBuffer(shard.buffer));
    assert.equal(shard.bytes, shard.buffer.length);
    assert.equal(shard.end, shard.buffer.length - 1);
    assert.equal(shard.buffer.toString('utf-8'), 'evil-pkg\tMAL-0001\t*\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-19 an ecosystem name containing a dot resolves to a real filename', () => {
  const files = defaultFiles();
  files['vuln-crates.io.json.gz'] = gzip(JSON.stringify({ 'openssl-src': [{ id: 'RUSTSEC-0001', aliases: [], ranges: [], severity: 'low', cwe: [], summary: 'x' }] }));
  files['malicious-crates.io.txt.gz'] = gzip('bad-crate\tMAL-0002\t1.0.0\n');
  const dir = buildStore({ files, patch: { ecosystems: { npm: { advisories: 1, malicious: 1 }, 'crates.io': { advisories: 1, malicious: 1 } } } });
  try {
    assert.equal(db.loadVulnShard(dir, 'crates.io').advisories['openssl-src'][0].id, 'RUSTSEC-0001');
    assert.equal(db.loadMaliciousShard(dir, 'crates.io').buffer.toString('utf-8').trim(), 'bad-crate\tMAL-0002\t1.0.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-20 status computes age_days from an injected now', () => {
  const dir = buildStore();
  try {
    const now = Date.parse(GENERATED_AT) + (3.5 * 24 * 60 * 60 * 1000);
    const report = db.status({ dir, now });
    assert.equal(report.present, true);
    assert.equal(report.dir, dir);
    assert.equal(report.generated_at, GENERATED_AT);
    assert.equal(report.age_days, 3);
    assert.equal(report.schema_version, db.SCHEMA_VERSION);
    assert.deepEqual(report.ecosystems, [
      { ecosystem: 'PyPI', advisories: 1, malicious: 0 },
      { ecosystem: 'npm', advisories: 1, malicious: 1 },
    ]);
    assert.equal(report.integrity.ok, true);
    assert.equal(report.error, null);

    const older = db.status({ dir, now: Date.parse(GENERATED_AT) + (400 * 24 * 60 * 60 * 1000) });
    assert.equal(older.age_days, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-21 status reports a missing or broken store without throwing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-home-'));
  const broken = buildStore({ patch: { schema_version: 99 } });
  try {
    withoutEnv(() => {
      const absent = db.status({ dir: path.join(home, 'absent'), homedir: home, version: '9.9.9' });
      if (!fs.existsSync(PACKAGED_DIR)) {
        assert.equal(absent.present, false);
        assert.equal(absent.dir, null);
        assert.equal(absent.age_days, null);
        assert.deepEqual(absent.ecosystems, []);
        assert.equal(absent.integrity, null);
      }
      const empty = db.status({ dir: home, homedir: home });
      assert.equal(empty.present, false);
      assert.equal(empty.dir, home);

      const mismatch = db.status({ dir: broken, homedir: home });
      assert.equal(mismatch.present, false);
      assert.equal(mismatch.error, 'advisory-schema-mismatch');
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test('DB-22 the loader accepts exactly what scripts/build-advisory-db.cjs writes', () => {
  const compact = require('../../../scripts/advisory-compact.cjs');
  const builder = require('../../../scripts/build-advisory-db.cjs');
  const built = compact.buildShards([
    {
      id: 'GHSA-npm-lodash',
      summary: 'prototype pollution',
      aliases: ['CVE-2020-8203'],
      affected: [{
        package: { ecosystem: 'npm', name: 'Lodash' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.20' }] }],
      }],
      database_specific: { severity: 'HIGH', cwe_ids: ['CWE-1321'] },
    },
    {
      id: 'MAL-2024-0001',
      summary: 'malicious code execution',
      affected: [{ package: { ecosystem: 'PyPI', name: 'Flask_SQLAlchemy' }, versions: ['9.9.9'] }],
    },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-built-'));
  try {
    builder.writeShards(dir, built, {
      generatedAt: GENERATED_AT,
      toolVersion: '1.5.0',
      feeds: [{ eco: 'npm', license: 'CC-BY-4.0' }, { eco: 'PyPI', license: 'CC-BY-4.0' }],
    });
    db._clearCache();
    const manifest = db.loadManifest(dir);
    assert.equal(manifest.schema_version, db.SCHEMA_VERSION);
    assert.equal(db.verifyIntegrity(dir, manifest).ok, true);
    const shard = db.loadVulnShard(dir, 'npm', { manifest });
    assert.equal(shard.advisories.lodash[0].severity, 'high');
    assert.deepEqual(shard.advisories.lodash[0].cve, ['CVE-2020-8203']);
    assert.deepEqual(shard.advisories.lodash[0].cwe, ['CWE-1321']);
    assert.equal(db.loadVulnShard(dir, 'PyPI', { manifest }), null);
    assert.equal(
      db.loadMaliciousShard(dir, 'PyPI', { manifest }).buffer.toString('utf-8'),
      'flask-sqlalchemy\tMAL-2024-0001\t9.9.9\n',
    );
    assert.equal(db.status({ dir, now: Date.parse(GENERATED_AT) }).age_days, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-23 an unknown ecosystem is rejected against the inventory vocabulary', () => {
  const dir = buildStore();
  try {
    assert.throws(() => db.loadVulnShard(dir, 'Fortran'), (err) => {
      assert.equal(err.code, 'inventory-unknown-ecosystem');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DB-24 an unverified shard load cannot serve a later verifying caller', () => {
  const compact = require('../../../scripts/advisory-compact.cjs');
  const builder = require('../../../scripts/build-advisory-db.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-db-poison-'));
  try {
    const built = compact.buildShards([{
      id: 'GHSA-x', summary: 's',
      affected: [{ package: { ecosystem: 'npm', name: 'yaml' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.0.0' }] }] }],
    }]);
    builder.writeShards(dir, built, {
      generatedAt: '2026-08-03T00:00:00.000Z', toolVersion: '1', feeds: [{ eco: 'npm', license: 'CC-BY-4.0' }],
    });
    db._clearCache();

    fs.writeFileSync(
      path.join(dir, 'vuln-npm.json.gz'),
      zlib.gzipSync(Buffer.from(JSON.stringify({ evil: [{ id: 'INJECTED' }] }), 'utf-8')),
    );

    const unverified = db.loadVulnShard(dir, 'npm', { skipIntegrity: true });
    assert.ok(unverified, 'an explicit skipIntegrity load still works');

    assert.throws(
      () => db.loadVulnShard(dir, 'npm', {}),
      (err) => {
        assert.equal(err.code, 'advisory-shard-tampered',
          'a verifying caller must not be served the cached unverified shard');
        return true;
      },
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
