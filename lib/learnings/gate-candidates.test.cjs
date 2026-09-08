'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const gates = require('./gate-candidates.cjs');
const learnings = require('../learnings.cjs');

function _mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-gate-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

test('GATE-1: an empty store yields no candidates', () => {
  const r = _mkRoot();
  try {
    const out = gates.gateCandidates(r, {});
    assert.deepEqual(out.candidates, []);
    assert.equal(out.scanned, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('GATE-2: verified learnings never become gate candidates', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'always place blueprint index calls inside the schema create closure', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'blueprint index calls must stay inside the schema create closure scope', outcome: 'verified' }, r);
    const out = gates.gateCandidates(r, {});
    assert.equal(out.negatives, 0);
    assert.deepEqual(out.candidates, []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('GATE-3: two differently-worded failures of the same class cluster together', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'every blueprint column index call must live inside the schema create closure otherwise it is silently dropped', outcome: 'failed' }, r);
    learnings.logLearning({ pattern: 'blueprint index column calls must stay inside the schema create closure because table is closure scoped', outcome: 'failed' }, r);
    learnings.logLearning({ pattern: 'prefer dependency injection over service location in controllers', outcome: 'failed' }, r);
    const out = gates.gateCandidates(r, {});
    assert.equal(out.negatives, 3);
    assert.equal(out.candidates.length, 1, 'exactly one class recurs');
    assert.equal(out.candidates[0].members, 2);
    assert.ok(out.candidates[0].shared_tokens.includes('blueprint'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('GATE-4: a single unrelated failure is not a recurring class', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'prefer dependency injection over service location in controllers', outcome: 'failed' }, r);
    assert.deepEqual(gates.gateCandidates(r, {}).candidates, []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('GATE-5: a learning that later failed counts through its outcome history', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'every blueprint column index call must live inside the schema create closure otherwise dropped', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'every blueprint column index call must live inside the schema create closure otherwise dropped', outcome: 'failed' }, r);
    learnings.logLearning({ pattern: 'blueprint index column calls must stay inside the schema create closure since table is closure scoped', outcome: 'reverted' }, r);
    const out = gates.gateCandidates(r, {});
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].members, 2);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
