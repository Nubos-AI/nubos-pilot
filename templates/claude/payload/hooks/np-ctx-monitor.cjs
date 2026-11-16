#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WARN_THRESHOLD = 35;
const CRITICAL_THRESHOLD = 25;
const DEBOUNCE_TOOLS = 5;

function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    process.stdin.setEncoding('utf-8');
    const timer = setTimeout(() => {
      try { process.stdin.removeAllListeners(); } catch {}
      resolve(safeParse(buf));
    }, 500);
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(safeParse(buf)); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(safeParse(buf)); });
  });
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function severityFor(remaining) {
  if (remaining <= CRITICAL_THRESHOLD) return 'critical';
  if (remaining <= WARN_THRESHOLD) return 'warning';
  return 'normal';
}

function sanitizeSid(sid) {
  return String(sid || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

(async () => {
  let payload = {};
  try { payload = await readStdinJson(); } catch { payload = {}; }
  const sid = payload && payload.session_id;
  if (!sid) { process.exit(0); return; }
  const safeSid = sanitizeSid(sid);
  const bridgePath = path.join(os.tmpdir(), 'claude-ctx-' + safeSid + '.json');
  if (!fs.existsSync(bridgePath)) { process.exit(0); return; }

  let bridge;
  try { bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf-8')); } catch { process.exit(0); return; }
  const remaining = Number(bridge && bridge.usable_remaining_pct);
  if (!Number.isFinite(remaining)) { process.exit(0); return; }

  const statePath = path.join(os.tmpdir(), 'claude-ctx-warn-' + safeSid + '.json');
  let state = { tool_count: 0, last_warn_at: -999, last_severity: 'normal' };
  try {
    const existing = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state = Object.assign(state, existing);
  } catch {}
  state.tool_count = Number(state.tool_count || 0) + 1;

  const sev = severityFor(remaining);
  const escalated = sev !== 'normal' && sev !== state.last_severity && state.last_severity !== 'critical';
  const firstWarn = state.last_severity === 'normal' && sev !== 'normal';
  const enoughGap = (state.tool_count - Number(state.last_warn_at || -999)) >= DEBOUNCE_TOOLS;

  if (sev === 'normal') {
    state.last_severity = 'normal';
    try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch {}
    process.exit(0); return;
  }

  if (!firstWarn && !escalated && !enoughGap) {
    try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch {}
    process.exit(0); return;
  }

  state.last_warn_at = state.tool_count;
  state.last_severity = sev;
  try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch {}

  const msg = sev === 'critical'
    ? 'CONTEXT CRITICAL: only ' + remaining + '% of usable context remaining. Stop taking new work — save state now with /np:pause-work before autocompact triggers.'
    : 'CONTEXT LOW: ' + remaining + '% of usable context remaining. Wrap up the current task and consider /np:pause-work soon.';

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: '[nubos-pilot ctx-monitor] ' + msg,
    },
  };
  process.stdout.write(JSON.stringify(output));
})().catch(() => { process.exit(0); });
