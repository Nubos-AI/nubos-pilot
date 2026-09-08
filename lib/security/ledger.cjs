'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withFileLock, atomicWriteFileSync } = require('../core.cjs');
const finding = require('../scan/finding.cjs');

const LEDGER_VERSION = 1;
const RISK_SEVERITIES = new Set(['risk', 'high', 'critical', 'fail']);

function sanitizeSid(sid) {
  return String(sid || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ledgerPath(sid) {
  return path.join(os.tmpdir(), 'claude-sec-' + sanitizeSid(sid) + '.json');
}

function _skeleton(sid) {
  return {
    session_id: String(sid || ''),
    version: LEDGER_VERSION,
    created_at: Date.now(),
    baseline: null,
    seen_scan: {},
    findings: [],
    review_in_flight: null,
    stop_streak: 0,
    commit_review_times: [],
  };
}

function _read(sid) {
  const p = ledgerPath(sid);
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); }
  catch { return _skeleton(sid); }
  if (!raw || raw.trim() === '') return _skeleton(sid);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return _skeleton(sid); }
  if (!parsed || typeof parsed !== 'object') return _skeleton(sid);
  return Object.assign(_skeleton(sid), parsed);
}

function _isPidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return !!(err && err.code === 'EPERM'); }
}

function withLedger(sid, fn) {
  const p = ledgerPath(sid);
  return withFileLock(p, () => {
    const ledger = _read(sid);
    const result = fn(ledger);
    atomicWriteFileSync(p, JSON.stringify(ledger), 'utf-8', 0o600);
    return result;
  });
}

function readLedger(sid) {
  return _read(sid);
}

function initSession(sid) {
  return withLedger(sid, (l) => { l.created_at = l.created_at || Date.now(); return { session_id: l.session_id }; });
}

function setBaseline(sid, baseline) {
  return withLedger(sid, (l) => {
    l.baseline = Object.assign({ captured_at: Date.now() }, baseline || {});
    return l.baseline;
  });
}

function _scanKey(f) {
  return String(f.file) + '::' + String(f.rule_name);
}

function markScanReported(sid, findings) {
  const list = Array.isArray(findings) ? findings : [];
  return withLedger(sid, (l) => {
    const fresh = [];
    for (const f of list) {
      const key = _scanKey(f);
      if (l.seen_scan[key]) continue;
      l.seen_scan[key] = true;
      fresh.push(f);
    }
    return fresh;
  });
}

function _fingerprint(f) {
  return finding.fingerprint(f);
}

function addReviewFindings(sid, findings, layer) {
  const list = Array.isArray(findings) ? findings : [];
  return withLedger(sid, (l) => {
    const existing = new Set(l.findings.map((f) => f.fp));
    let added = 0;
    for (const f of list) {
      const fp = _fingerprint(f);
      if (existing.has(fp)) continue;
      existing.add(fp);
      l.findings.push({
        fp,
        id: f.id || null,
        file: f.file || null,
        line: f.line == null ? null : f.line,
        category: f.category || null,
        severity: finding.normalizeSeverity(f.severity),
        cwe: Array.isArray(f.cwe) ? f.cwe : [],
        package: f.package || null,
        fixed_version: f.fixed_version || null,
        title: f.title || f.rule_name || null,
        mitigation_hint: f.mitigation_hint || f.reminder || null,
        layer: layer || null,
        surfaced: false,
        addressed: false,
        created_at: Date.now(),
      });
      added++;
    }
    return { added };
  });
}

function takeUnsurfacedRisks(sid, opts) {
  const maxStreak = opts && Number.isFinite(opts.maxStreak) ? opts.maxStreak : 3;
  return withLedger(sid, (l) => {
    const unsurfaced = l.findings.filter((f) => !f.surfaced && RISK_SEVERITIES.has(String(f.severity)));
    if (unsurfaced.length === 0) {
      l.stop_streak = 0;
      return { findings: [], yielded: false };
    }
    if (l.stop_streak >= maxStreak) {
      for (const f of unsurfaced) f.surfaced = true;
      l.stop_streak = 0;
      return { findings: [], yielded: true };
    }
    for (const f of unsurfaced) f.surfaced = true;
    l.stop_streak += 1;
    return { findings: unsurfaced.map((f) => ({ ...f })), yielded: false };
  });
}

function tryBeginReview(sid, opts) {
  const staleMs = opts && Number.isFinite(opts.staleMs) ? opts.staleMs : 5 * 60 * 1000;
  return withLedger(sid, (l) => {
    const cur = l.review_in_flight;
    if (cur && typeof cur === 'object') {
      const age = Date.now() - Number(cur.started_at || 0);
      const stale = age > staleMs || !_isPidAlive(Number(cur.pid));
      if (!stale) return { began: false, reason: 'in-flight' };
    }
    l.review_in_flight = { pid: process.pid, started_at: Date.now() };
    return { began: true };
  });
}

function endReview(sid) {
  return withLedger(sid, (l) => { l.review_in_flight = null; return { ok: true }; });
}

function tryRecordCommitReview(sid, opts) {
  const maxPerHour = opts && Number.isFinite(opts.maxPerHour) ? opts.maxPerHour : 20;
  const windowMs = 60 * 60 * 1000;
  return withLedger(sid, (l) => {
    const now = Date.now();
    l.commit_review_times = (l.commit_review_times || []).filter((t) => now - t < windowMs);
    if (l.commit_review_times.length >= maxPerHour) return { allowed: false, count: l.commit_review_times.length };
    l.commit_review_times.push(now);
    return { allowed: true, count: l.commit_review_times.length };
  });
}

function removeLedger(sid) {
  try { fs.unlinkSync(ledgerPath(sid)); } catch {}
}

module.exports = {
  LEDGER_VERSION,
  RISK_SEVERITIES,
  sanitizeSid,
  ledgerPath,
  withLedger,
  readLedger,
  initSession,
  setBaseline,
  markScanReported,
  addReviewFindings,
  takeUnsurfacedRisks,
  tryBeginReview,
  endReview,
  tryRecordCommitReview,
  removeLedger,
  _fingerprint,
};
