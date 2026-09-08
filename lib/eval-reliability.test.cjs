'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { summarize, describe } = require('./eval-reliability.cjs');

test('ER-1: all pass → reliable-pass, aggregate 0', () => {
  const s = summarize([0, 0, 0]);
  assert.strictEqual(s.verdict, 'reliable-pass');
  assert.strictEqual(s.pass_at_k, true);
  assert.strictEqual(s.pass_at_1, true);
  assert.strictEqual(s.flaky, false);
  assert.strictEqual(s.aggregate_exit_code, 0);
});

test('ER-2: all fail → reliable-fail, aggregate non-zero', () => {
  const s = summarize([1, 1, 1]);
  assert.strictEqual(s.verdict, 'reliable-fail');
  assert.strictEqual(s.pass_at_k, false);
  assert.strictEqual(s.flaky, false);
  assert.strictEqual(s.aggregate_exit_code, 1);
});

test('ER-3: mixed → flaky, aggregate non-zero (pass^k)', () => {
  const s = summarize([0, 1, 0]);
  assert.strictEqual(s.verdict, 'flaky');
  assert.strictEqual(s.flaky, true);
  assert.strictEqual(s.pass_at_1, true);
  assert.strictEqual(s.pass_at_k, false);
  assert.strictEqual(s.aggregate_exit_code, 1);
});

test('ER-4: first-run-fail-then-pass is still flaky and red', () => {
  const s = summarize([1, 0, 0]);
  assert.strictEqual(s.flaky, true);
  assert.strictEqual(s.pass_at_1, false);
  assert.strictEqual(s.aggregate_exit_code, 1);
});

test('ER-5: single run preserves classic behaviour', () => {
  assert.strictEqual(summarize([0]).aggregate_exit_code, 0);
  assert.strictEqual(summarize([2]).aggregate_exit_code, 1);
  assert.strictEqual(summarize([0]).verdict, 'reliable-pass');
});

test('ER-6: empty/invalid input throws', () => {
  assert.throws(() => summarize([]), (e) => e.code === 'eval-reliability-no-runs');
  assert.throws(() => summarize('nope'), (e) => e.code === 'eval-reliability-no-runs');
  assert.throws(() => summarize([0, 1.5]), (e) => e.code === 'eval-reliability-bad-code');
});

test('ER-7: describe is human-readable and flags flaky loudly', () => {
  assert.match(describe(summarize([0])), /passed \(1 run\)/);
  assert.match(describe(summarize([0, 0, 0])), /reliably passed/);
  assert.match(describe(summarize([0, 1, 0])), /FLAKY/);
});
