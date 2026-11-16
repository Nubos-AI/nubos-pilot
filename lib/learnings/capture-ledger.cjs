'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Rate-limit ledger for Stop-hook learning auto-capture. Mirrors the ADR-0020
// security ledger's posture (sliding per-hour window + consecutive-stop streak)
// but is its own concern and its own file. Per-session JSON under the OS temp
// dir; a session that never stops leaves nothing behind worth cleaning.

const DIR = path.join(os.tmpdir(), 'nubos-pilot-learnings');

function sanitizeSid(sid) {
  return String(sid || 'nosid').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function ledgerPath(sid) {
  return path.join(DIR, sanitizeSid(sid) + '.json');
}

function _read(sid) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(sid), 'utf-8'));
  } catch {
    return { session_id: sanitizeSid(sid), created_at: Date.now(), capture_times: [], stop_streak: 0 };
  }
}

function _write(sid, l) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ledgerPath(sid), JSON.stringify(l), 'utf-8');
  } catch { /* a rate-limit ledger must never break the session */ }
}

/**
 * Record an attempt to auto-capture on this session's Stop. Returns whether the
 * capture is allowed under both caps. The per-hour window prevents runaway cost;
 * the in-a-row streak prevents back-to-back Stops (e.g. a tight edit loop) each
 * firing an extraction.
 * @returns {{allowed: boolean, count: number, streak: number, reason?: string}}
 */
function tryRecordCapture(sid, opts) {
  const maxPerHour = opts && Number.isFinite(opts.maxPerHour) ? opts.maxPerHour : 10;
  const maxStreak = opts && Number.isFinite(opts.maxStreak) ? opts.maxStreak : 3;
  const now = Date.now();
  const hourAgo = now - 3600 * 1000;

  const l = _read(sid);
  l.capture_times = (Array.isArray(l.capture_times) ? l.capture_times : []).filter((t) => t > hourAgo);
  l.stop_streak = Number.isFinite(l.stop_streak) ? l.stop_streak : 0;

  if (l.capture_times.length >= maxPerHour) {
    _write(sid, l);
    return { allowed: false, count: l.capture_times.length, streak: l.stop_streak, reason: 'per-hour-cap' };
  }
  if (l.stop_streak >= maxStreak) {
    _write(sid, l);
    return { allowed: false, count: l.capture_times.length, streak: l.stop_streak, reason: 'streak-cap' };
  }

  l.capture_times.push(now);
  l.stop_streak += 1;
  _write(sid, l);
  return { allowed: true, count: l.capture_times.length, streak: l.stop_streak };
}

/** Reset the consecutive-stop streak — call after a user prompt (real activity). */
function resetStreak(sid) {
  const l = _read(sid);
  l.stop_streak = 0;
  _write(sid, l);
}

function removeLedger(sid) {
  try { fs.unlinkSync(ledgerPath(sid)); } catch {}
}

module.exports = { tryRecordCapture, resetStreak, removeLedger, ledgerPath, sanitizeSid, _read };
