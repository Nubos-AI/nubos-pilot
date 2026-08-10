'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const manifestMod = require('./manifest.cjs');

function _mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-man-'));
}

test('MAN-TRAV-1 readManifest rejects keys with traversal segments', () => {
  const dir = _mkTmp();
  try {
    const cases = [
      { '../../etc/passwd': 'abc' },
      { 'a/../b': 'abc' },
      { '..': 'abc' },
    ];
    for (const files of cases) {
      const manifestPath = path.join(dir, '.manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ version: '1', timestamp: 't', files }), 'utf-8');
      let thrown = null;
      try { manifestMod.readManifest(dir); } catch (e) { thrown = e; }
      assert.ok(thrown, 'expected throw for: ' + JSON.stringify(files));
      assert.equal(thrown.code, 'manifest-invalid-path', 'unexpected code for: ' + JSON.stringify(files) + ': ' + thrown.code);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('MAN-TRAV-2 readManifest rejects keys with absolute paths', () => {
  const dir = _mkTmp();
  try {
    const cases = [
      { '/etc/passwd': 'abc' },
      { '\\Windows\\System32': 'abc' },
      { 'C:/Windows/System32': 'abc' },
      { 'D:\\Users\\foo': 'abc' },
      { '': 'abc' },
    ];
    for (const files of cases) {
      const manifestPath = path.join(dir, '.manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ version: '1', timestamp: 't', files }), 'utf-8');
      let thrown = null;
      try { manifestMod.readManifest(dir); } catch (e) { thrown = e; }
      assert.ok(thrown, 'expected throw for: ' + JSON.stringify(files));
      assert.equal(thrown.code, 'manifest-invalid-path', 'unexpected code for: ' + JSON.stringify(files) + ': ' + thrown.code);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('MAN-TRAV-3 readManifest still accepts plain POSIX-relative keys', () => {
  const dir = _mkTmp();
  try {
    const manifestPath = path.join(dir, '.manifest.json');
    const files = { 'agents/np-foo.md': 'aaa', 'templates/x/y.md': 'bbb', '.hidden': 'ccc' };
    fs.writeFileSync(manifestPath, JSON.stringify({ version: '1', timestamp: 't', files }), 'utf-8');
    const parsed = manifestMod.readManifest(dir);
    assert.equal(parsed.files['agents/np-foo.md'], 'aaa');
    assert.equal(parsed.files['templates/x/y.md'], 'bbb');
    assert.equal(parsed.files['.hidden'], 'ccc');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('MAN-TRAV-4 prototype-pollution keys are still rejected with their own code', () => {
  const dir = _mkTmp();
  try {
    const manifestPath = path.join(dir, '.manifest.json');
    const raw = '{"version":"1","timestamp":"t","files":{"__proto__":{"polluted":true}}}';
    fs.writeFileSync(manifestPath, raw, 'utf-8');
    let thrown = null;
    try { manifestMod.readManifest(dir); } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.equal(thrown.code, 'manifest-invalid-structure');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('MAN-TRAV-5 assertSafeManifestKey is exported and accepts legit names with leading dots (..bar, foo..bar)', () => {
  // These pass — only `..` as a *full segment* is traversal. Dot-prefixed
  // filenames (`..build-id`, `..bar`) are legitimate. Regression-guard
  // against the old `rel.includes('..')` check in uninstall (B3-1).
  manifestMod.assertSafeManifestKey('..bar', 'test');
  manifestMod.assertSafeManifestKey('foo..bar', 'test');
  manifestMod.assertSafeManifestKey('foo/..bar/x', 'test');
  manifestMod.assertSafeManifestKey('.hidden', 'test');
});

test('MAN-TRAV-6 assertSafeManifestKey rejects traversal segments and absolute paths', () => {
  const bad = ['../etc', '..', 'foo/..', 'foo/../bar', '/etc', '\\Windows', 'C:/x', '', '\\\\server\\share'];
  for (const k of bad) {
    let thrown = null;
    try { manifestMod.assertSafeManifestKey(k, 'test'); } catch (e) { thrown = e; }
    assert.ok(thrown, 'expected reject for: ' + JSON.stringify(k));
    assert.equal(thrown.code, 'manifest-invalid-path');
  }
});
