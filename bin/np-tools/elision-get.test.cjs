'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const elisionGet = require('./elision-get.cjs');
const elision = require('../../lib/elision.cjs');
const { NubosPilotError } = require('../../lib/core.cjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-elisionget-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

function capture() {
  const chunks = [];
  return { stream: { write: (s) => chunks.push(s) }, text: () => chunks.join('') };
}

test('ELISIONGET-1: prints the original for a known hash', () => {
  const root = sandbox();
  try {
    const hash = elision.store('the original payload', { type: 'plain' }, root);
    const out = capture();
    const code = elisionGet.run([hash], { cwd: root, stdout: out.stream });
    assert.equal(code, 0);
    assert.equal(out.text(), 'the original payload');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISIONGET-2: unknown hash exits 1 with a not-found notice', () => {
  const root = sandbox();
  try {
    const out = capture();
    const code = elisionGet.run(['aaaaaaaaaaaa'], { cwd: root, stdout: out.stream });
    assert.equal(code, 1);
    assert.match(out.text(), /not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISIONGET-3: --json emits the retrieval envelope', () => {
  const root = sandbox();
  try {
    const hash = elision.store('payload', { type: 'plain' }, root);
    const out = capture();
    const code = elisionGet.run([hash, '--json'], { cwd: root, stdout: out.stream });
    assert.equal(code, 0);
    const env = JSON.parse(out.text());
    assert.equal(env.status, 'ok');
    assert.equal(env.original, 'payload');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISIONGET-4: missing hash throws', () => {
  assert.throws(() => elisionGet.run([], { cwd: process.cwd(), stdout: { write() {} } }), NubosPilotError);
});
