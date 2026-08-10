'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./state-incr.cjs');

const STATE_SEED = [
  '---',
  'schema_version: 2',
  'milestone: null',
  'milestone_name: null',
  'current_phase: null',
  'current_plan: null',
  'current_task: null',
  'last_updated: null',
  'progress:',
  '  total_phases: 0',
  '  completed_phases: 0',
  '  total_plans: 0',
  '  completed_plans: 0',
  '  percent: 0',
  'session:',
  '  stopped_at: null',
  '  resume_file: null',
  '  last_activity: null',
  '---',
  '',
  '# State',
  '',
].join('\n');

function mkSandbox(withCounter) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-si-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'));
  let content = STATE_SEED;
  if (withCounter != null) {
    content = content.replace('schema_version: 2', 'schema_version: 2\npending_todos: ' + withCounter);
  }
  fs.writeFileSync(path.join(dir, '.nubos-pilot', 'STATE.md'), content);
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (c) => { chunks.push(c); } },
    read: () => chunks.join(''),
  };
}

test('SI-1: first increment sets pending_todos to 1', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run(['pending_todos'], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const out = JSON.parse(cap.read());
    assert.equal(out.ok, true);
    assert.equal(out.value, 1);
    const written = fs.readFileSync(path.join(dir, '.nubos-pilot', 'STATE.md'), 'utf-8');
    assert.match(written, /pending_todos: 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SI-2: increments existing counter', () => {
  const dir = mkSandbox(3);
  try {
    const cap = captureStdout();
    mod.run(['pending_todos'], { cwd: dir, stdout: cap.stream });
    const out = JSON.parse(cap.read());
    assert.equal(out.value, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SI-3: unknown key rejected', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => mod.run(['bogus'], { cwd: dir, stdout: { write: () => {} } }),
      (err) => err.code === 'state-incr-unknown-key',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SI-4: missing key rejected', () => {
  assert.throws(
    () => mod.run([], { cwd: '/tmp', stdout: { write: () => {} } }),
    (err) => err.code === 'state-incr-missing-key',
  );
});
