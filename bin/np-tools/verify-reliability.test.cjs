'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { run } = require('./verify-reliability.cjs');

function _capture() {
  const out = { text: '' };
  const err = { text: '' };
  return {
    stdout: { write: (s) => { out.text += s; return true; } },
    stderr: { write: (s) => { err.text += s; return true; } },
    out, err,
  };
}

test('VR-1: all-pass codes → aggregate 0, reliable-pass', () => {
  const c = _capture();
  const code = run(['--codes', '0,0,0'], c);
  assert.strictEqual(code, 0);
  const r = JSON.parse(c.out.text);
  assert.strictEqual(r.aggregate_exit_code, 0);
  assert.strictEqual(r.verdict, 'reliable-pass');
});

test('VR-2: flaky codes → aggregate 1, flaky verdict + loud description', () => {
  const c = _capture();
  const code = run(['--codes', '0,1,0'], c);
  assert.strictEqual(code, 0);
  const r = JSON.parse(c.out.text);
  assert.strictEqual(r.aggregate_exit_code, 1);
  assert.strictEqual(r.flaky, true);
  assert.match(r.description, /FLAKY/);
});

test('VR-3: --codes= form supported', () => {
  const c = _capture();
  const code = run(['--codes=1,1'], c);
  assert.strictEqual(code, 0);
  assert.strictEqual(JSON.parse(c.out.text).verdict, 'reliable-fail');
});

test('VR-4: missing --codes → error envelope, exit 1', () => {
  const c = _capture();
  const code = run([], c);
  assert.strictEqual(code, 1);
  assert.match(c.err.text, /verify-reliability-missing-codes/);
});

test('VR-5: unknown arg → error envelope, exit 1', () => {
  const c = _capture();
  const code = run(['--bogus'], c);
  assert.strictEqual(code, 1);
  assert.match(c.err.text, /verify-reliability-unknown-arg/);
});

test('VR-6: empty codes → internal error envelope, exit 1', () => {
  const c = _capture();
  const code = run(['--codes', ''], c);
  assert.strictEqual(code, 1);
  assert.match(c.err.text, /eval-reliability-no-runs/);
});

test('VR-7: --help → usage exit 0', () => {
  const c = _capture();
  const code = run(['--help'], c);
  assert.strictEqual(code, 0);
  assert.match(c.out.text, /verify-reliability/);
});
