'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const rc = require('./run-context.cjs');

beforeEach(() => rc._resetForTests());

test('RC-1 getRunId generates a new id when ENV is unset and seeds it into the env', () => {
  const id = rc.getRunId();
  assert.ok(rc.RUN_ID_RE.test(id), 'must match RUN_ID_RE: ' + id);
  assert.equal(process.env[rc.ENV_KEY], id);
});

test('RC-2 getRunId is sticky across calls', () => {
  const id1 = rc.getRunId();
  const id2 = rc.getRunId();
  assert.equal(id1, id2);
});

test('RC-3 ENV-seeded id is honoured when matching pattern', () => {
  process.env[rc.ENV_KEY] = 'r-12345678-abcd';
  const id = rc.getRunId();
  assert.equal(id, 'r-12345678-abcd');
});

test('RC-4 garbage ENV value is ignored and a fresh id is generated', () => {
  process.env[rc.ENV_KEY] = 'short';
  const id = rc.getRunId();
  assert.notEqual(id, 'short');
  assert.ok(rc.RUN_ID_RE.test(id));
});

test('RC-5 setRunId enforces pattern and updates ENV', () => {
  rc.setRunId('r-aa-bb-cc-dd');
  assert.equal(rc.getRunId(), 'r-aa-bb-cc-dd');
  assert.equal(process.env[rc.ENV_KEY], 'r-aa-bb-cc-dd');

  assert.throws(() => rc.setRunId('bad id with spaces'));
  assert.throws(() => rc.setRunId(''));
  assert.throws(() => rc.setRunId(null));
});

test('RC-6 generateRunId produces unique strings under tight loop', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = rc.generateRunId();
    assert.ok(rc.RUN_ID_RE.test(id));
    assert.equal(seen.has(id), false, 'collision: ' + id);
    seen.add(id);
  }
});
