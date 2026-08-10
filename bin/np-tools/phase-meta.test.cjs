'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./phase-meta.cjs');

const SEED = [
  'schema_version: 1',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: First',
  '    goal: hello',
  '    status: pending',
  '    requirements: [UTIL-01, UTIL-02]',
  '    success_criteria:',
  '      - {id: SC-1, text: logs in}',
  '      - {id: SC-2, text: logs out}',
  '    slices: []',
  '',
].join('\n');

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pm-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'));
  fs.writeFileSync(path.join(dir, '.nubos-pilot', 'roadmap.yaml'), SEED);
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (c) => { chunks.push(c); } },
    read: () => chunks.join(''),
  };
}

test('PM-1: _validateMilestone accepts M002, 2, and 2.1', () => {
  assert.equal(mod._validateMilestone('M002'), '002');
  assert.equal(mod._validateMilestone('2'), '2');
  assert.equal(mod._validateMilestone('2.1'), '2.1');
});

test('PM-2: _validateMilestone rejects garbage', () => {
  assert.throws(
    () => mod._validateMilestone('bogus'),
    (err) => err.code === 'phase-meta-invalid-milestone',
  );
});

test('PM-3: run() without --field emits full projected JSON', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['1'], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const out = JSON.parse(cap.read());
    assert.equal(out.name, 'First');
    assert.equal(out.goal, 'hello');
    assert.deepEqual(out.requirements, ['UTIL-01', 'UTIL-02']);
    assert.equal(out.success_criteria.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM-4: --field success_criteria emits just that array as JSON', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['1', '--field', 'success_criteria'], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const arr = JSON.parse(cap.read());
    assert.equal(arr.length, 2);
    assert.equal(arr[0].id, 'SC-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM-5: --field success_criteria --length emits count', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['1', '--field', 'success_criteria', '--length'], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    assert.equal(cap.read(), '2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM-6: --length on non-array field throws', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    assert.throws(
      () => mod.run(['1', '--field', 'name', '--length'], { cwd: dir, stdout: cap.stream }),
      (err) => err.code === 'phase-meta-length-non-array',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM-7: unknown field throws', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    assert.throws(
      () => mod.run(['1', '--field', 'bogus'], { cwd: dir, stdout: cap.stream }),
      (err) => err.code === 'phase-meta-unknown-field',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM-8: missing milestone in roadmap throws phase-meta-not-found', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    assert.throws(
      () => mod.run(['99'], { cwd: dir, stdout: cap.stream }),
      (err) => err.code === 'phase-meta-not-found',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
