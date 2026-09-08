const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = require('../../bin/install.js');
const db = require('../../lib/scan/advisory/db.cjs');
const compact = require('../../scripts/advisory-compact.cjs');
const builder = require('../../scripts/build-advisory-db.cjs');

const PKG_VERSION = require('../../package.json').version;
const GENERATED_AT = '2026-02-01T00:00:00.000Z';

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

function sandbox(t, scope) {
  const root = mkTmp(scope);
  const home = mkTmp(scope + '-home');
  const source = mkTmp(scope + '-src');
  t.after(() => {
    for (const dir of [root, home, source]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
  return { root, home, source, target: db.homeDbDir({ homedir: home, version: PKG_VERSION }) };
}

function writeSnapshot(dir) {
  const built = compact.buildShards([
    {
      id: 'GHSA-inst-0001',
      summary: 'prototype pollution',
      aliases: ['CVE-2026-0001'],
      affected: [{
        package: { ecosystem: 'npm', name: 'lodash' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
      }],
    },
    {
      id: 'MAL-2026-0001',
      summary: 'malicious code execution',
      affected: [{ package: { ecosystem: 'npm', name: 'evil-pkg' }, versions: ['1.0.0'] }],
    },
  ]);
  return builder.writeShards(dir, built, {
    generatedAt: GENERATED_AT,
    toolVersion: '1.5.0',
    feeds: [{ eco: 'npm', license: 'CC-BY-4.0' }],
  });
}

function runInstall(box, over) {
  return install.runInstall(Object.assign({
    cwd: box.root,
    mode: 'init',
    flags: { agents: ['claude'], scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
    advisorySourceDir: box.source,
    advisoryHomedir: box.home,
  }, over || {}));
}

test('INST-ADB-1 a package without a snapshot installs cleanly and creates no cache dir', async (t) => {
  const box = sandbox(t, 'adb-absent');
  const result = await runInstall(box);
  assert.equal(result.dryRun, false);
  assert.ok(result.written > 0, 'the payload must still be installed');
  assert.ok(!fs.existsSync(path.join(box.home, '.nubos-pilot', 'advisory-db')),
    'an absent snapshot must not create the shared cache at all');
});

test('INST-ADB-2 a shipped snapshot is copied into the per-user cache and verifies', async (t) => {
  const box = sandbox(t, 'adb-copy');
  const manifest = writeSnapshot(box.source);
  await runInstall(box);

  assert.ok(fs.existsSync(path.join(box.target, 'manifest.json')),
    'the copy must land in ~/.nubos-pilot/advisory-db/<version>/');
  db._clearCache();
  assert.equal(db.verifyIntegrity(box.target).ok, true, 'every copied shard must match its digest');
  assert.deepEqual(
    fs.readdirSync(box.target).sort(),
    ['manifest.json', ...Object.keys(manifest.sha256)].sort(),
    'exactly the manifest and its shards are copied — nothing else',
  );
  assert.equal(db.status({ dir: box.target, now: Date.parse(GENERATED_AT) }).present, true);
});

test('INST-ADB-2b the snapshot never lands in the install payload tree', async (t) => {
  const box = sandbox(t, 'adb-payload');
  writeSnapshot(box.source);
  await runInstall(box);

  const payloadDir = path.join(box.root, '.claude', 'nubos-pilot');
  const stray = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (/\.gz$/.test(entry.name) || entry.name === 'manifest.json') stray.push(abs);
    }
  };
  walk(payloadDir);
  assert.deepEqual(stray, [],
    'the Install-Payload tree carries only .cjs + Markdown (ADR-0002, ADR-0005)');
});

test('INST-ADB-3 a snapshot whose shard fails its digest leaves no half-copied store', async (t) => {
  const box = sandbox(t, 'adb-corrupt');
  writeSnapshot(box.source);
  const shard = path.join(box.source, 'vuln-npm.json.gz');
  const bytes = fs.readFileSync(shard);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(shard, bytes);

  const result = await runInstall(box);
  assert.ok(result.written > 0, 'a failed snapshot copy must not abort the install');
  assert.ok(!fs.existsSync(box.target),
    'a store that failed verification must be removed, never left looking valid');
});

test('INST-ADB-4 a second install with the same snapshot is a no-op', async (t) => {
  const box = sandbox(t, 'adb-idempotent');
  writeSnapshot(box.source);
  await runInstall(box);

  const files = fs.readdirSync(box.target).map((name) => path.join(box.target, name));
  const stamp = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
  for (const file of files) fs.utimesSync(file, stamp, stamp);

  await runInstall(box, { mode: 'update' });

  for (const file of files) {
    assert.equal(Math.floor(fs.statSync(file).mtimeMs / 1000), stamp,
      path.basename(file) + ' was rewritten by an install that had nothing to copy');
  }
  db._clearCache();
  assert.equal(db.verifyIntegrity(box.target).ok, true);
});

test('INST-ADB-5 a dry-run reports the copy it would make and writes nothing', async (t) => {
  const box = sandbox(t, 'adb-dryrun');
  writeSnapshot(box.source);
  const summary = await runInstall(box, { dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.wouldCopyAdvisoryDb, true);
  assert.ok(!fs.existsSync(box.target), 'a preview must not create the shared cache');
});

test('INST-ADB-5b a dry-run without a shipped snapshot reports no copy', async (t) => {
  const box = sandbox(t, 'adb-dryrun-absent');
  const summary = await runInstall(box, { dryRun: true });
  assert.equal(summary.wouldCopyAdvisoryDb, false);
});
