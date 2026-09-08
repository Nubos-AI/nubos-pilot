'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./state-dir.cjs');

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sd-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'));
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (c) => { chunks.push(c); } },
    read: () => chunks.join(''),
  };
}

test('SD-1: run() without --subdir returns .nubos-pilot path', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run([], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    assert.equal(cap.read(), path.join(dir, '.nubos-pilot'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SD-2: --subdir notes appends the segment', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['--subdir', 'notes'], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    assert.equal(cap.read(), path.join(dir, '.nubos-pilot', 'notes'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SD-3: .. in subdir rejected', () => {
  assert.throws(
    () => mod._validateSubdir('../etc'),
    (err) => err.code === 'state-dir-invalid-subdir',
  );
});

test('SD-4: absolute subdir rejected', () => {
  assert.throws(
    () => mod._validateSubdir('/etc/passwd'),
    (err) => err.code === 'state-dir-invalid-subdir',
  );
});

test('SD-5: special chars rejected', () => {
  assert.throws(
    () => mod._validateSubdir('x$(whoami)'),
    (err) => err.code === 'state-dir-invalid-subdir',
  );
});

test('SD-6: nested slash allowed (threads/open)', () => {
  assert.equal(mod._validateSubdir('threads/open'), 'threads/open');
});
