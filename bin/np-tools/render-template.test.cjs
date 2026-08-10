'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./render-template.cjs');

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rt-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'));
  const tplDir = path.join(dir, '.nubos-pilot', 'templates', 'milestone');
  fs.mkdirSync(tplDir, { recursive: true });
  fs.writeFileSync(path.join(tplDir, 'CONTEXT.md'), '# {{title}}\n\nGoal: {{goal}}\n');
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (c) => { chunks.push(c); } },
    read: () => chunks.join(''),
  };
}

test('RT-1: renders template with --vars', () => {
  const dir = mkSandbox();
  try {
    const cap = captureStdout();
    const rc = mod.run([
      'milestone/CONTEXT',
      '--vars', JSON.stringify({ title: 'Auth', goal: 'Log in works' }),
    ], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    assert.equal(cap.read(), '# Auth\n\nGoal: Log in works\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-2: --vars-file also works', () => {
  const dir = mkSandbox();
  try {
    const varsPath = path.join(dir, 'vars.json');
    fs.writeFileSync(varsPath, JSON.stringify({ title: 'X', goal: 'Y' }));
    const cap = captureStdout();
    const rc = mod.run([
      'milestone/CONTEXT',
      '--vars-file', varsPath,
    ], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    assert.equal(cap.read(), '# X\n\nGoal: Y\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-3: missing name throws', () => {
  assert.throws(
    () => mod.run(['--vars', '{}'], { cwd: '/tmp', stdout: { write: () => {} } }),
    (err) => err.code === 'render-template-missing-name',
  );
});

test('RT-4: missing vars throws', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => mod.run(['milestone/CONTEXT'], { cwd: dir, stdout: { write: () => {} } }),
      (err) => err.code === 'render-template-missing-vars',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-5: invalid JSON vars throws', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => mod.run(['milestone/CONTEXT', '--vars', '{broken'], { cwd: dir, stdout: { write: () => {} } }),
      (err) => err.code === 'render-template-invalid-vars',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-6: non-object vars (array) rejected', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => mod.run(['milestone/CONTEXT', '--vars', '[]'], { cwd: dir, stdout: { write: () => {} } }),
      (err) => err.code === 'render-template-invalid-vars',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-7: missing placeholder in vars throws template-unresolved-var', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => mod.run(['milestone/CONTEXT', '--vars', '{"title":"X"}'], { cwd: dir, stdout: { write: () => {} } }),
      (err) => err.code === 'template-unresolved-var',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
