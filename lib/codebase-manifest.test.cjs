const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const m = require('./codebase-manifest.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cbm-'));
  _sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('CM-1: readManifest returns empty manifest when file missing', () => {
  const root = makeSandbox();
  const result = m.readManifest(root);
  assert.equal(result.schema_version, m.SCHEMA_VERSION);
  assert.deepEqual(result.files, {});
});

test('CM-2: writeManifest then readManifest roundtrips', () => {
  const root = makeSandbox();
  const input = {
    schema_version: m.SCHEMA_VERSION,
    files: {
      'src/a.js': { sha256: 'sha256:aa', size: 10, ext: '.js' },
      'src/b.py': { sha256: 'sha256:bb', size: 20, ext: '.py' },
    },
  };
  m.writeManifest(root, input);
  const read = m.readManifest(root);
  assert.equal(read.schema_version, m.SCHEMA_VERSION);
  assert.equal(read.files['src/a.js'].sha256, 'sha256:aa');
  assert.equal(read.files['src/b.py'].size, 20);
  assert.ok(read.generated_at);
});

test('CM-3: manifestPath places file at .nubos-pilot/codebase/.hashes.json', () => {
  const root = makeSandbox();
  const p = m.manifestPath(root);
  assert.equal(p, path.join(root, '.nubos-pilot', 'codebase', '.hashes.json'));
});

test('CM-4: manifestFromScanFiles converts scan files[] to manifest shape', () => {
  const scanFiles = [
    { path: 'src/a.js', sha256: 'sha256:11', size: 5, ext: '.js' },
    { path: 'src/b.py', sha256: 'sha256:22', size: 7, ext: '.py' },
    { path: 'no-hash.bin' },
  ];
  const manifest = m.manifestFromScanFiles(scanFiles);
  assert.equal(manifest.schema_version, m.SCHEMA_VERSION);
  assert.equal(Object.keys(manifest.files).length, 2);
  assert.equal(manifest.files['src/a.js'].sha256, 'sha256:11');
  assert.equal(manifest.files['src/b.py'].ext, '.py');
});

test('CM-5: diffManifest detects added, removed, changed, unchanged', () => {
  const prev = {
    schema_version: 1,
    files: {
      'kept.js': { sha256: 'sha256:a', size: 1, ext: '.js' },
      'changed.js': { sha256: 'sha256:old', size: 1, ext: '.js' },
      'removed.js': { sha256: 'sha256:r', size: 1, ext: '.js' },
    },
  };
  const next = {
    schema_version: 1,
    files: {
      'kept.js': { sha256: 'sha256:a', size: 1, ext: '.js' },
      'changed.js': { sha256: 'sha256:new', size: 2, ext: '.js' },
      'added.js': { sha256: 'sha256:n', size: 1, ext: '.js' },
    },
  };
  const diff = m.diffManifest(prev, next);
  assert.deepEqual(diff.added.map((x) => x.path), ['added.js']);
  assert.deepEqual(diff.removed.map((x) => x.path), ['removed.js']);
  assert.deepEqual(diff.changed.map((x) => x.path), ['changed.js']);
  assert.deepEqual(diff.unchanged.map((x) => x.path), ['kept.js']);
  assert.equal(diff.changed[0].prev_sha256, 'sha256:old');
  assert.equal(diff.changed[0].sha256, 'sha256:new');
  assert.deepEqual(diff.summary, { added: 1, removed: 1, changed: 1, unchanged: 1 });
});

test('CM-6: diffManifest handles empty prev (bootstrap case)', () => {
  const next = {
    schema_version: 1,
    files: {
      'a.js': { sha256: 'sha256:a', size: 1, ext: '.js' },
      'b.js': { sha256: 'sha256:b', size: 1, ext: '.js' },
    },
  };
  const diff = m.diffManifest(m.emptyManifest(), next);
  assert.equal(diff.summary.added, 2);
  assert.equal(diff.summary.removed, 0);
  assert.equal(diff.summary.changed, 0);
  assert.equal(diff.summary.unchanged, 0);
});

test('CM-7: readManifest throws on schema mismatch', () => {
  const root = makeSandbox();
  const p = m.manifestPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ schema_version: 99, files: {} }));
  assert.throws(
    () => m.readManifest(root),
    (err) => err.code === 'manifest-schema-mismatch',
  );
});

test('CM-8: readManifest throws on invalid JSON', () => {
  const root = makeSandbox();
  const p = m.manifestPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{not json');
  assert.throws(
    () => m.readManifest(root),
    (err) => err.code === 'manifest-parse-error',
  );
});

test('CM-9: stalePathsForDocs flags docs whose sources changed', () => {
  const diff = {
    added: [{ path: 'new.js' }],
    changed: [{ path: 'src/auth/login.js' }],
    removed: [],
  };
  const docIndex = {
    'modules/auth.md': ['src/auth/login.js', 'src/auth/session.js'],
    'modules/billing.md': ['src/billing/invoice.js'],
    'modules/shared.md': ['new.js'],
  };
  const result = m.stalePathsForDocs(diff, docIndex);
  assert.deepEqual(result.stale_docs, ['modules/auth.md', 'modules/shared.md']);
  assert.ok(result.touched_paths.includes('src/auth/login.js'));
  assert.ok(result.touched_paths.includes('new.js'));
});

test('CM-10: writeManifest is atomic and creates codebase dir', () => {
  const root = makeSandbox();
  const result = m.writeManifest(root, {
    files: { 'x.js': { sha256: 'sha256:x', size: 1, ext: '.js' } },
  });
  const p = m.manifestPath(root);
  assert.ok(fs.existsSync(p));
  assert.equal(result.files['x.js'].sha256, 'sha256:x');
});
