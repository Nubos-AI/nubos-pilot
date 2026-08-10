'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const ledger = require('./ledger.cjs');

let _sidCounter = 0;
function freshSid() {
  _sidCounter += 1;
  return 'test-sec-' + process.pid + '-' + _sidCounter;
}
function cleanup(sid) {
  ledger.removeLedger(sid);
  try { fs.unlinkSync(ledger.ledgerPath(sid) + '.lock'); } catch {}
}

test('LED-1 scan report-once: same pattern+file reported only once per session', () => {
  const sid = freshSid();
  try {
    const f = [{ file: 'a.js', rule_name: 'eval_call' }];
    const first = ledger.markScanReported(sid, f);
    const second = ledger.markScanReported(sid, f);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
  } finally { cleanup(sid); }
});

test('LED-2 scan dedup is per-file: same rule on a different file is fresh', () => {
  const sid = freshSid();
  try {
    ledger.markScanReported(sid, [{ file: 'a.js', rule_name: 'eval_call' }]);
    const other = ledger.markScanReported(sid, [{ file: 'b.js', rule_name: 'eval_call' }]);
    assert.equal(other.length, 1);
  } finally { cleanup(sid); }
});

test('LED-3 review findings dedup by fingerprint (cross-layer)', () => {
  const sid = freshSid();
  try {
    const finding = { file: 'x.js', line: 10, category: 'injection', severity: 'risk', title: 'SQLi' };
    const a = ledger.addReviewFindings(sid, [finding], 'stop');
    const b = ledger.addReviewFindings(sid, [finding], 'commit');
    assert.equal(a.added, 1);
    assert.equal(b.added, 0);
  } finally { cleanup(sid); }
});

test('LED-4 takeUnsurfacedRisks surfaces once, then nothing', () => {
  const sid = freshSid();
  try {
    ledger.addReviewFindings(sid, [{ file: 'x.js', line: 1, category: 'authz', severity: 'risk', title: 'bypass' }], 'stop');
    const first = ledger.takeUnsurfacedRisks(sid, { maxStreak: 3 });
    const second = ledger.takeUnsurfacedRisks(sid, { maxStreak: 3 });
    assert.equal(first.findings.length, 1);
    assert.equal(second.findings.length, 0);
  } finally { cleanup(sid); }
});

test('LED-5 only risk-class severities surface; warn does not block', () => {
  const sid = freshSid();
  try {
    ledger.addReviewFindings(sid, [{ file: 'x.js', line: 2, category: 'style', severity: 'warn', title: 'nit' }], 'stop');
    const r = ledger.takeUnsurfacedRisks(sid, {});
    assert.equal(r.findings.length, 0);
  } finally { cleanup(sid); }
});

test('LED-6 a single surfacing drains all currently-unsurfaced risks at once', () => {
  const sid = freshSid();
  try {
    for (let i = 0; i < 5; i++) {
      ledger.addReviewFindings(sid, [{ file: 'f' + i + '.js', line: i, category: 'injection', severity: 'risk', title: 't' + i }], 'stop');
    }
    const r1 = ledger.takeUnsurfacedRisks(sid, { maxStreak: 3 });
    const r2 = ledger.takeUnsurfacedRisks(sid, { maxStreak: 3 });
    assert.equal(r1.findings.length, 5);
    assert.equal(r2.findings.length, 0);
  } finally { cleanup(sid); }
});

test('LED-6b once streak hits max with leftovers, it yields back to the user', () => {
  const sid = freshSid();
  try {
    let streak = 0;
    let yielded = false;
    for (let turn = 0; turn < 10; turn++) {
      ledger.addReviewFindings(sid, [{ file: 'g' + turn + '.js', line: turn, category: 'injection', severity: 'risk', title: 'g' + turn }], 'stop');
      const r = ledger.takeUnsurfacedRisks(sid, { maxStreak: 3 });
      if (r.yielded) { yielded = true; break; }
      streak++;
    }
    assert.ok(yielded, 'should yield within a few turns');
    assert.ok(streak <= 3, 'never more than maxStreak consecutive blocks');
  } finally { cleanup(sid); }
});

test('LED-7 concurrency guard: second begin while in-flight is rejected', () => {
  const sid = freshSid();
  try {
    const a = ledger.tryBeginReview(sid, {});
    const b = ledger.tryBeginReview(sid, {});
    assert.equal(a.began, true);
    assert.equal(b.began, false);
    ledger.endReview(sid);
    const c = ledger.tryBeginReview(sid, {});
    assert.equal(c.began, true);
  } finally { cleanup(sid); }
});

test('LED-7b stale in-flight (old timestamp) is reclaimed', () => {
  const sid = freshSid();
  try {
    ledger.tryBeginReview(sid, {});
    ledger.withLedger(sid, (l) => { l.review_in_flight.started_at = Date.now() - 10 * 60 * 1000; });
    const c = ledger.tryBeginReview(sid, { staleMs: 5 * 60 * 1000 });
    assert.equal(c.began, true);
  } finally { cleanup(sid); }
});

test('LED-8 commit rolling-hour cap enforced', () => {
  const sid = freshSid();
  try {
    let lastAllowed = true;
    for (let i = 0; i < 20; i++) lastAllowed = ledger.tryRecordCommitReview(sid, { maxPerHour: 20 }).allowed;
    assert.equal(lastAllowed, true);
    const over = ledger.tryRecordCommitReview(sid, { maxPerHour: 20 });
    assert.equal(over.allowed, false);
  } finally { cleanup(sid); }
});

test('LED-9 baseline round-trips', () => {
  const sid = freshSid();
  try {
    ledger.setBaseline(sid, { head: 'abc123' });
    assert.equal(ledger.readLedger(sid).baseline.head, 'abc123');
  } finally { cleanup(sid); }
});
