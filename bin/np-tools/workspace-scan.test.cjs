'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./workspace-scan.cjs');

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ws-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n\nLine 1\nLine 2\n');
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (c) => { chunks.push(c); } },
    read: () => chunks.join(''),
  };
}

test('WS-1: default run emits full scan result JSON', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run([], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const out = JSON.parse(cap.read());
    assert.ok(out.stats);
    assert.ok(out.language_distribution);
    assert.equal(typeof out.stats.file_count, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WS-2: --summary emits the new-project shape', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['--summary'], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const out = JSON.parse(cap.read());
    assert.ok('file_count' in out);
    assert.ok('langs' in out);
    assert.ok('manifests' in out);
    assert.ok('docs' in out);
    assert.ok('readme_head' in out);
    assert.ok('git' in out);
    assert.match(out.readme_head, /^# Test/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WS-3: --batch-size accepts positive integer', () => {
  assert.deepEqual(mod._parseArgs(['--batch-size', '500']), { batchSize: 500, summary: false });
});

test('WS-4: --batch-size rejects non-positive', () => {
  assert.throws(
    () => mod._parseArgs(['--batch-size', '0']),
    (err) => err.code === 'workspace-scan-invalid-batch-size',
  );
});

test('WS-5: --batch-size rejects NaN', () => {
  assert.throws(
    () => mod._parseArgs(['--batch-size', 'ten']),
    (err) => err.code === 'workspace-scan-invalid-batch-size',
  );
});
