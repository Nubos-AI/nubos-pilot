'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./update-phase-meta.cjs');
const roadmap = require('../../lib/roadmap.cjs');

const SEED = [
  'schema_version: 1',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: First',
  '    goal: hello',
  '    status: pending',
  '    requirements: []',
  '    success_criteria: []',
  '    slices: []',
  '',
].join('\n');

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-upm-'));
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

test('UPM-1: _validateMilestone accepts M002, 2, and 2.1', () => {
  assert.equal(mod._validateMilestone('M002'), '002');
  assert.equal(mod._validateMilestone('2'), '2');
  assert.equal(mod._validateMilestone('2.1'), '2.1');
});

test('UPM-2: _validateMilestone rejects garbage', () => {
  assert.throws(
    () => mod._validateMilestone('bogus'),
    (err) => err.code === 'update-phase-meta-invalid-milestone',
  );
});

test('UPM-3: run() writes SCs via --json flag', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['1', '--json', JSON.stringify({
      success_criteria: [{ id: 'SC-1', text: 'log in works' }],
    })], { cwd: dir, stdout: cap.stream, stdinIsTty: true });
    assert.equal(rc, 0);
    const p = roadmap.getPhase(1, dir);
    assert.equal(p.success_criteria.length, 1);
    const out = JSON.parse(cap.read());
    assert.equal(out.ok, true);
    assert.deepEqual(out.result.fields_updated, ['success_criteria']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UPM-4: invalid JSON via --json throws update-phase-meta-invalid-json', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    assert.throws(
      () => mod.run(['1', '--json', '{broken'], { cwd: dir, stdout: cap.stream, stdinIsTty: true }),
      (err) => err.code === 'update-phase-meta-invalid-json',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UPM-5: JSON-array (not object) patch rejected', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => mod.run(['1', '--json', '[]'], { cwd: dir, stdout: captureStdout().stream, stdinIsTty: true }),
      (err) => err.code === 'update-phase-meta-invalid-json',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UPM-6: missing JSON throws update-phase-meta-missing-json', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => mod.run(['1'], { cwd: dir, stdout: captureStdout().stream, stdinIsTty: true }),
      (err) => err.code === 'update-phase-meta-missing-json',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UPM-7: missing milestone arg throws update-phase-meta-missing-milestone', () => {
  assert.throws(
    () => mod.run(['--json', '{"goal":"x"}'], { cwd: process.cwd(), stdout: captureStdout().stream }),
    (err) => err.code === 'update-phase-meta-missing-milestone',
  );
});

test('UPM-8: run() reads from piped stdin when stdinIsTty false', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['1'], {
      cwd: dir,
      stdout: cap.stream,
      stdinIsTty: false,
      readStdin: () => JSON.stringify({ requirements: ['REQ-42'] }),
    });
    assert.equal(rc, 0);
    const p = roadmap.getPhase(1, dir);
    assert.deepEqual(p.requirements, ['REQ-42']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
