'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { check, EXPECTED, EXCEPTIONS } = require('../scripts/check-offhost-coverage.cjs');

test('OFFHOST-COVERAGE: every workflow agent-spawn has an off-host branch, no drift', () => {
  const r = check();
  assert.deepStrictEqual(r.gaps, [], 'off-host coverage gaps:\n' + r.gaps.join('\n'));
  assert.deepStrictEqual(r.drift, [], 'undocumented spawn sites (drift):\n' + r.drift.join('\n'));
  assert.ok(r.ok);
});

test('OFFHOST-COVERAGE: matrix + exceptions are non-empty', () => {
  assert.ok(EXPECTED.length >= 14, 'expected >= 14 wired spawn sites');
  assert.ok(EXCEPTIONS.length >= 1, 'expected documented exceptions');
});
