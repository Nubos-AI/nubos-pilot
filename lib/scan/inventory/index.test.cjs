'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inventory = require('./index.cjs');

function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-inv-'));
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const LOCK_V3 = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo', dependencies: { yaml: '^2.8.0' }, devDependencies: { tap: '^18.0.0' } },
    'node_modules/yaml': { version: '2.8.0', license: 'ISC' },
    'node_modules/tap': { version: '18.0.0', dev: true },
  },
});

const CARGO_LOCK = [
  'version = 3',
  '',
  '[[package]]',
  'name = "serde"',
  'version = "1.0.197"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
].join('\n');

test('INV-1 every parser basename resolves to a parser', () => {
  for (const parser of inventory.PARSERS) {
    for (const basename of parser.FILES) {
      assert.equal(inventory.parserFor(basename), parser, basename);
    }
  }
});

test('INV-2 requirements.txt variants all route to the python parser', () => {
  const base = inventory.parserFor('requirements.txt');
  assert.ok(base);
  for (const name of ['requirements-dev.txt', 'dev-requirements.txt', 'requirements-test.txt']) {
    assert.equal(inventory.parserFor(name), base, name);
  }
  assert.equal(inventory.parserFor('notes.txt'), null);
  assert.equal(inventory.parserFor('README.md'), null);
});

test('INV-3 discover finds manifests across nested directories, sorted', () => {
  const root = tree({
    'package-lock.json': LOCK_V3,
    'sub/deep/Cargo.lock': CARGO_LOCK,
    'notes.md': '# hi',
  });
  try {
    const { manifests } = inventory.discover(root, {});
    assert.deepEqual(manifests.map((m) => m.relPath), ['package-lock.json', 'sub/deep/Cargo.lock']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-4 discover skips node_modules and other default excludes', () => {
  const root = tree({
    'package-lock.json': LOCK_V3,
    'node_modules/dep/package-lock.json': LOCK_V3,
    'vendor/pkg/composer.lock': '{}',
    'dist/package-lock.json': LOCK_V3,
  });
  try {
    const { manifests } = inventory.discover(root, {});
    assert.deepEqual(manifests.map((m) => m.relPath), ['package-lock.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-5 discover requires a root', () => {
  assert.throws(() => inventory.discover('', {}), /requires a root/);
  assert.throws(() => inventory.discover(null, {}), /requires a root/);
});

test('INV-6 collect merges several ecosystems into one deduped inventory', () => {
  const root = tree({ 'package-lock.json': LOCK_V3, 'Cargo.lock': CARGO_LOCK });
  try {
    const result = inventory.collect(root, {});
    assert.deepEqual(result.ecosystems, ['crates.io', 'npm']);
    const purls = result.packages.map((p) => p.purl);
    assert.ok(purls.includes('pkg:npm/yaml@2.8.0'), purls.join(','));
    assert.ok(purls.includes('pkg:cargo/serde@1.0.197'), purls.join(','));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-7 collect preserves the dev/prod split needed for gating', () => {
  const root = tree({ 'package-lock.json': LOCK_V3 });
  try {
    const { packages, counts } = inventory.collect(root, {});
    assert.equal(packages.find((p) => p.name === 'yaml').scope, 'prod');
    assert.equal(packages.find((p) => p.name === 'tap').scope, 'dev');
    assert.equal(counts.by_scope.prod, 1);
    assert.equal(counts.by_scope.dev, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-8 gatable drops the ignored scopes and keeps the rest', () => {
  const root = tree({ 'package-lock.json': LOCK_V3 });
  try {
    const { packages } = inventory.collect(root, {});
    const gated = inventory.gatable(packages, ['dev']);
    assert.deepEqual(gated.map((p) => p.name), ['yaml']);
    assert.equal(inventory.gatable(packages, []).length, 2);
    assert.equal(inventory.gatable(packages, ['dev', 'prod']).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-9 collect reports per-file counts and surfaces parser warnings', () => {
  const root = tree({ 'package-lock.json': '{ not json' });
  try {
    const result = inventory.collect(root, {});
    assert.equal(result.packages.length, 0);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].file, 'package-lock.json');
    assert.ok(result.warnings.length > 0, 'a malformed lockfile must warn, never vanish silently');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-10 a malformed manifest never aborts the whole collect', () => {
  const root = tree({ 'package-lock.json': '{ not json', 'Cargo.lock': CARGO_LOCK });
  try {
    const result = inventory.collect(root, {});
    assert.ok(result.packages.some((p) => p.name === 'serde'), 'the healthy manifest must still be parsed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-11 warnings are deduplicated across manifests', () => {
  const root = tree({ 'package-lock.json': '{ bad', 'a/package-lock.json': '{ bad' });
  try {
    const { warnings } = inventory.collect(root, {});
    assert.equal(warnings.length, new Set(warnings).size);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-12 byEcosystem groups packages for shard-scoped lookup', () => {
  const root = tree({ 'package-lock.json': LOCK_V3, 'Cargo.lock': CARGO_LOCK });
  try {
    const { packages } = inventory.collect(root, {});
    const grouped = inventory.byEcosystem(packages);
    assert.deepEqual([...grouped.keys()].sort(), ['crates.io', 'npm']);
    assert.equal(grouped.get('crates.io').length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-13 counts report direct and versioned totals', () => {
  const root = tree({ 'package-lock.json': LOCK_V3 });
  try {
    const { counts } = inventory.collect(root, {});
    assert.equal(counts.total, 2);
    assert.equal(counts.versioned, 2);
    assert.equal(counts.by_ecosystem.npm, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-14 an empty project yields an empty inventory, not an error', () => {
  const root = tree({ 'README.md': '# nothing here' });
  try {
    const result = inventory.collect(root, {});
    assert.deepEqual(result.packages, []);
    assert.deepEqual(result.ecosystems, []);
    assert.equal(result.counts.total, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-15 symlinked manifests are not followed', () => {
  const root = tree({ 'real/package-lock.json': LOCK_V3 });
  try {
    try { fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), 'dir'); }
    catch { return; }
    const { manifests } = inventory.discover(root, {});
    assert.deepEqual(manifests.map((m) => m.relPath), ['real/package-lock.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-16 collect on this repository finds its own declared dependency', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const result = inventory.collect(repoRoot, {});
  const yaml = result.packages.find((p) => p.ecosystem === 'npm' && p.name === 'yaml');
  assert.ok(yaml, 'nubos-pilot declares yaml as its one runtime dependency');
  assert.ok(result.ecosystems.includes('npm'));
  assert.equal(result.packages.every((p) => p.purl.startsWith('pkg:')), true);
});

test('INV-17 a requirements file inside a requirements/ directory is discovered', () => {
  const root = tree({
    'requirements/base.txt': 'flask==3.0.0\n',
    'requirements/dev.txt': 'pytest==8.0.0\n',
    'docs/notes.txt': 'not a manifest\n',
  });
  try {
    const { manifests } = inventory.discover(root, {});
    assert.deepEqual(manifests.map((m) => m.relPath), ['requirements/base.txt', 'requirements/dev.txt']);
    const { packages } = inventory.collect(root, {});
    assert.ok(packages.some((p) => p.name === 'pytest'), 'requirements/dev.txt must be parsed, not just found');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-18 a plain .txt file is never mistaken for a manifest', () => {
  const root = tree({ 'notes.txt': 'hello', 'LICENSE.txt': 'MIT' });
  try {
    assert.deepEqual(inventory.discover(root, {}).manifests, []);
    assert.equal(inventory.parserFor('notes.txt'), null);
    assert.equal(inventory.parserFor('docs/requirements.md'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INV-19 lockfiles are discoverable even though the content walker excludes them', () => {
  const { DEFAULT_EXCLUDES, DEFAULT_DIR_EXCLUDES, DEFAULT_GENERATED_EXCLUDES } = require('../walk.cjs');
  assert.deepEqual(DEFAULT_EXCLUDES, [...DEFAULT_DIR_EXCLUDES, ...DEFAULT_GENERATED_EXCLUDES]);
  assert.ok(DEFAULT_GENERATED_EXCLUDES.some((g) => g.includes('package-lock.json')));
  assert.ok(!DEFAULT_DIR_EXCLUDES.some((g) => g.includes('package-lock.json')));
  const root = tree({ 'package-lock.json': LOCK_V3 });
  try {
    assert.equal(inventory.discover(root, {}).manifests.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
