'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const safe = require('./safe-path.cjs');

function _mk() { return fs.mkdtempSync(path.join(os.tmpdir(), 'np-safe-')); }

test('SP-INSIDE-1 absolute candidate inside base passes', () => {
  const dir = _mk();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const out = safe.assertInsideBase(dir, path.join(dir, 'a.txt'), 'test');
    assert.equal(out, path.join(dir, 'a.txt'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SP-INSIDE-2 relative candidate is resolved against base', () => {
  const dir = _mk();
  try {
    const out = safe.assertInsideBase(dir, 'sub/x', 'test');
    assert.equal(out, path.join(dir, 'sub/x'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SP-INSIDE-3 traversal candidate (..) outside base throws safe-path-outside-base', () => {
  const dir = _mk();
  try {
    assert.throws(
      () => safe.assertInsideBase(dir, '../escape', 'prompt-path'),
      (err) => err.code === 'safe-path-outside-base' && err.details.label === 'prompt-path',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SP-INSIDE-4 symlink inside base pointing OUTSIDE base is rejected via realpath', () => {
  const baseDir = _mk();
  const outsideDir = _mk();
  try {
    const evilLink = path.join(baseDir, 'evil');
    fs.symlinkSync(outsideDir, evilLink);
    fs.writeFileSync(path.join(outsideDir, 'secret'), 'x');
    assert.throws(
      () => safe.assertInsideBase(baseDir, path.join(evilLink, 'secret'), 'test'),
      (err) => err.code === 'safe-path-outside-base',
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('SP-INSIDE-5b candidate with non-existent ancestor chain anchors to baseReal (CW2-2)', () => {
  const dir = _mk();
  try {
    // No traversal — should pass. Previously lexical-fallback could allow escape.
    const out = safe.assertInsideBase(dir, 'a/b/c/d', 'test');
    assert.equal(out, path.join(dir, 'a/b/c/d'));
    // With traversal — must reject.
    assert.throws(
      () => safe.assertInsideBase(dir, 'a/b/../../../escape', 'test'),
      (err) => err.code === 'safe-path-outside-base',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SP-INSIDE-5c assertInsideBase throws safe-path-base-missing for non-existent base (CW2-2)', () => {
  const ghost = path.join(os.tmpdir(), 'np-safe-ghost-' + Math.random().toString(36).slice(2));
  assert.throws(
    () => safe.assertInsideBase(ghost, 'x', 'test'),
    (err) => err.code === 'safe-path-base-missing',
  );
});

test('SP-ANY-1 assertInsideAnyOf accepts candidate inside any of the bases', () => {
  const d1 = _mk();
  const d2 = _mk();
  try {
    assert.equal(safe.assertInsideAnyOf([d1, d2], path.join(d1, 'a'), 'p'), path.join(d1, 'a'));
    assert.equal(safe.assertInsideAnyOf([d1, d2], path.join(d2, 'b'), 'p'), path.join(d2, 'b'));
  } finally { fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true }); }
});

test('SP-ANY-2 assertInsideAnyOf throws when candidate is outside all bases', () => {
  const d1 = _mk();
  try {
    assert.throws(
      () => safe.assertInsideAnyOf([d1, os.tmpdir()], '/etc/passwd', 'p'),
      (err) => err.code === 'safe-path-outside-base',
    );
  } finally { fs.rmSync(d1, { recursive: true, force: true }); }
});

test('SP-INSIDE-5 error details only leak basenames (redaction)', () => {
  const dir = _mk();
  try {
    let thrown;
    try { safe.assertInsideBase(dir, '/etc/passwd', 'test'); }
    catch (err) { thrown = err; }
    assert.ok(thrown);
    assert.equal(thrown.details.base, path.basename(dir));
    assert.equal(thrown.details.candidate, 'passwd');  // basename only
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SP-IDENT-1 valid identifier passes', () => {
  assert.equal(safe.assertSafeIdentifier('np-critic-style', 'agent'), 'np-critic-style');
  assert.equal(safe.assertSafeIdentifier('valid_name_123', 'thing'), 'valid_name_123');
});

test('SP-IDENT-2 invalid identifier throws', () => {
  for (const bad of ['', 'a/b', '../x', 'with spaces', 'name.with.dot', 'a'.repeat(200), null]) {
    assert.throws(
      () => safe.assertSafeIdentifier(bad, 'agent'),
      (err) => err.code === 'safe-path-invalid-identifier',
    );
  }
});

test('SP-GIT-REF-1 normal refs pass', () => {
  for (const ok of ['main', 'feature/foo', 'release-1.2.3', 'v1.0', 'topic/x_y-z']) {
    assert.equal(safe.assertSafeGitRef(ok, 'ref'), ok);
  }
});

test('SP-GIT-REF-2 leading dash and traversal rejected', () => {
  for (const bad of ['-x', '--exec=touch /tmp/pwn', 'a..b', '../etc/passwd', 'with space', '$(rm)']) {
    assert.throws(
      () => safe.assertSafeGitRef(bad, 'ref'),
      (err) => err.code === 'safe-path-invalid-git-ref',
    );
  }
});

test('SP-FLAG-1 normal value passes', () => {
  assert.equal(safe.assertSafeFlagValue('foo.md', '--prompt-path'), 'foo.md');
});

test('SP-FLAG-2 value that looks like another flag is rejected unless allowDashValues', () => {
  assert.throws(
    () => safe.assertSafeFlagValue('--other-flag', '--prompt-path'),
    (err) => err.code === 'safe-path-flag-value-looks-like-flag',
  );
  // opt-in allow:
  assert.equal(
    safe.assertSafeFlagValue('--negative-tag', '--reason', { allowDashValues: true }),
    '--negative-tag',
  );
});

test('SP-FLAG-3 empty/non-string value rejected', () => {
  assert.throws(
    () => safe.assertSafeFlagValue('', '--prompt-path'),
    (err) => err.code === 'safe-path-missing-flag-value',
  );
  assert.throws(
    () => safe.assertSafeFlagValue(null, '--prompt-path'),
    (err) => err.code === 'safe-path-missing-flag-value',
  );
});
