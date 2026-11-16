'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseVector, baseScore, severityFromScore, severityFromVector } = require('./cvss.cjs');

const KNOWN = [
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8, 'critical'],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', 7.5, 'high'],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', 5.3, 'medium'],
  ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 7.8, 'high'],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1, 'medium'],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0, 'info'],
];

test('CVSS-1 published base scores are reproduced exactly', () => {
  for (const [vector, expected] of KNOWN) {
    assert.equal(baseScore(vector), expected, vector);
  }
});

test('CVSS-2 severity bands follow the published thresholds', () => {
  for (const [vector, , band] of KNOWN) {
    assert.equal(severityFromVector(vector), band, vector);
  }
});

test('CVSS-3 band boundaries are inclusive at the lower edge', () => {
  assert.equal(severityFromScore(9.0), 'critical');
  assert.equal(severityFromScore(8.9), 'high');
  assert.equal(severityFromScore(7.0), 'high');
  assert.equal(severityFromScore(6.9), 'medium');
  assert.equal(severityFromScore(4.0), 'medium');
  assert.equal(severityFromScore(3.9), 'low');
  assert.equal(severityFromScore(0.1), 'low');
  assert.equal(severityFromScore(0), 'info');
});

test('CVSS-4 a 3.0 vector is accepted as well as 3.1', () => {
  assert.equal(baseScore('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
});

test('CVSS-5 scope change applies the 1.08 multiplier', () => {
  const unchanged = baseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L');
  const changed = baseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:L');
  assert.ok(changed > unchanged, changed + ' should exceed ' + unchanged);
});

test('CVSS-6 an unparseable or foreign vector yields null, never a guess', () => {
  for (const bad of ['', null, undefined, 'not-a-vector', 'CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P', '9.8', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N']) {
    assert.equal(baseScore(bad), null, String(bad));
    assert.equal(severityFromVector(bad), null, String(bad));
  }
});

test('CVSS-7 a vector missing a required metric is refused', () => {
  assert.equal(parseVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H'), null);
  assert.equal(baseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H'), null);
});

test('CVSS-8 an out-of-vocabulary metric value is refused, not defaulted', () => {
  assert.equal(baseScore('CVSS:3.1/AV:Z/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), null);
});

test('CVSS-9 temporal and environmental metrics are ignored, not fatal', () => {
  const withExtras = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O/RC:C';
  assert.equal(baseScore(withExtras), 9.8);
});

test('CVSS-10 parseVector is case-insensitive on keys and values', () => {
  assert.equal(baseScore('CVSS:3.1/av:n/ac:l/pr:n/ui:n/s:u/c:h/i:h/a:h'), 9.8);
});

test('CVSS-11 roundup never rounds a score down', () => {
  for (const [vector, expected] of KNOWN) {
    const score = baseScore(vector);
    assert.ok(score >= expected - 1e-9, vector + ' rounded below its published score');
  }
});
