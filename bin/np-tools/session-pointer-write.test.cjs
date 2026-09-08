'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./session-pointer-write.cjs');

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-spw-'));
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

test('SPW-1: writes pointer atomically', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const iso = '2026-04-22T12:34:56Z';
    const rc = mod.run([iso], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const written = fs.readFileSync(path.join(dir, '.nubos-pilot', 'reports', '.last-session'), 'utf-8');
    assert.equal(written, iso);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SPW-2: missing iso throws', () => {
  assert.throws(
    () => mod.run([], { cwd: '/tmp', stdout: { write: () => {} } }),
    (err) => err.code === 'session-pointer-missing-iso',
  );
});

test('SPW-3: invalid iso throws', () => {
  assert.throws(
    () => mod._validateIso('not-a-date'),
    (err) => err.code === 'session-pointer-invalid-iso',
  );
});

test('SPW-4: accepts fractional seconds', () => {
  assert.equal(mod._validateIso('2026-04-22T12:34:56.789Z'), '2026-04-22T12:34:56.789Z');
});

test('SPW-5: rejects missing Z suffix', () => {
  assert.throws(
    () => mod._validateIso('2026-04-22T12:34:56'),
    (err) => err.code === 'session-pointer-invalid-iso',
  );
});
