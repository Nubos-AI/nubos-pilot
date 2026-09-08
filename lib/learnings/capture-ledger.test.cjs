'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { tryRecordCapture, resetStreak, removeLedger } = require('./capture-ledger.cjs');

function _sid(name) { return 'np-test-ledger-' + name + '-' + process.pid; }

test('CL-1: streak cap blocks after maxStreak consecutive stops', () => {
  const sid = _sid('streak');
  removeLedger(sid);
  try {
    assert.strictEqual(tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 3 }).allowed, true);
    assert.strictEqual(tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 3 }).allowed, true);
    assert.strictEqual(tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 3 }).allowed, true);
    const blocked = tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 3 });
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.reason, 'streak-cap');
  } finally { removeLedger(sid); }
});

test('CL-2: resetStreak clears the streak so capture is allowed again', () => {
  const sid = _sid('reset');
  removeLedger(sid);
  try {
    tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 2 });
    tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 2 });
    assert.strictEqual(tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 2 }).allowed, false);
    resetStreak(sid);
    assert.strictEqual(tryRecordCapture(sid, { maxPerHour: 100, maxStreak: 2 }).allowed, true);
  } finally { removeLedger(sid); }
});

test('CL-3: per-hour cap blocks regardless of streak resets', () => {
  const sid = _sid('hour');
  removeLedger(sid);
  try {
    assert.strictEqual(tryRecordCapture(sid, { maxPerHour: 2, maxStreak: 100 }).allowed, true);
    resetStreak(sid);
    assert.strictEqual(tryRecordCapture(sid, { maxPerHour: 2, maxStreak: 100 }).allowed, true);
    resetStreak(sid);
    const blocked = tryRecordCapture(sid, { maxPerHour: 2, maxStreak: 100 });
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.reason, 'per-hour-cap');
  } finally { removeLedger(sid); }
});

test('CL-4: a fresh session starts allowed', () => {
  const sid = _sid('fresh');
  removeLedger(sid);
  try {
    assert.strictEqual(tryRecordCapture(sid, {}).allowed, true);
  } finally { removeLedger(sid); }
});
