'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./thread-resume.cjs');

function mkSandbox(fmLines, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tr-'));
  const p = path.join(dir, 'thread.md');
  const content = '---\n' + fmLines.join('\n') + '\n---\n' + (body || '# body\n');
  fs.writeFileSync(p, content);
  return { dir, p };
}

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (c) => { chunks.push(c); } },
    read: () => chunks.join(''),
  };
}

test('TR-1: OPEN bumps to IN_PROGRESS', () => {
  assert.equal(mod._bumpStatus('OPEN'), 'IN_PROGRESS');
});

test('TR-2: IN_PROGRESS stays IN_PROGRESS', () => {
  assert.equal(mod._bumpStatus('IN_PROGRESS'), 'IN_PROGRESS');
});

test('TR-3: RESOLVED stays RESOLVED (monotonic)', () => {
  assert.equal(mod._bumpStatus('RESOLVED'), 'RESOLVED');
});

test('TR-4: run() bumps OPEN and writes last_resumed', () => {
  const { dir, p } = mkSandbox([
    'slug: foo',
    'status: OPEN',
    'created: 2026-04-01',
    'last_resumed: 2026-04-01',
  ], '# Thread: foo\n');
  try {
    const cap = captureStdout();
    const rc = mod.run([p, '--today', '2026-04-22'], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const written = fs.readFileSync(p, 'utf-8');
    assert.match(written, /status: IN_PROGRESS/);
    assert.match(written, /last_resumed: 2026-04-22/);
    const out = JSON.parse(cap.read());
    assert.equal(out.status, 'IN_PROGRESS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TR-5: RESOLVED stays RESOLVED across resume', () => {
  const { dir, p } = mkSandbox([
    'slug: bar',
    'status: RESOLVED',
    'created: 2026-04-01',
    'last_resumed: 2026-04-10',
  ], '# body\n');
  try {
    const cap = captureStdout();
    mod.run([p, '--today', '2026-04-22'], { cwd: dir, stdout: cap.stream });
    const written = fs.readFileSync(p, 'utf-8');
    assert.match(written, /status: RESOLVED/);
    assert.match(written, /last_resumed: 2026-04-22/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TR-6: stable field ordering (slug, status, created, last_resumed)', () => {
  const { dir, p } = mkSandbox([
    'last_resumed: 2026-04-01',
    'created: 2026-04-01',
    'status: OPEN',
    'slug: baz',
  ], '# body\n');
  try {
    const cap = captureStdout();
    mod.run([p, '--today', '2026-04-22'], { cwd: dir, stdout: cap.stream });
    const written = fs.readFileSync(p, 'utf-8');
    const fmBlock = written.split('---')[1];
    const idxSlug = fmBlock.indexOf('slug:');
    const idxStatus = fmBlock.indexOf('status:');
    const idxCreated = fmBlock.indexOf('created:');
    const idxLast = fmBlock.indexOf('last_resumed:');
    assert.ok(idxSlug < idxStatus && idxStatus < idxCreated && idxCreated < idxLast);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TR-7: missing path throws', () => {
  assert.throws(
    () => mod.run([], { cwd: '/tmp', stdout: { write: () => {} } }),
    (err) => err.code === 'thread-resume-missing-path',
  );
});

test('TR-8: nonexistent file throws read-error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tr-'));
  try {
    assert.throws(
      () => mod.run([path.join(dir, 'nope.md')], { cwd: dir, stdout: { write: () => {} } }),
      (err) => err.code === 'thread-resume-read-error',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TR-9: default today is current ISO date', () => {
  const { dir, p } = mkSandbox([
    'slug: x',
    'status: OPEN',
    'created: 2026-04-01',
    'last_resumed: 2026-04-01',
  ], '');
  try {
    const cap = captureStdout();
    mod.run([p], { cwd: dir, stdout: cap.stream });
    const out = JSON.parse(cap.read());
    assert.match(out.last_resumed, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
