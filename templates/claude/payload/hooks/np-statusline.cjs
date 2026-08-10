#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BAR_WIDTH = 10;
const AUTOCOMPACT_BUFFER = 0.835;
const DEFAULT_WINDOW = 200_000;
const EXTENDED_WINDOW = 1_000_000;

function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    process.stdin.setEncoding('utf-8');
    const timer = setTimeout(() => {
      try { process.stdin.removeAllListeners(); } catch {}
      resolve(safeParse(buf));
    }, 500);
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(safeParse(buf)); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(safeParse(buf)); });
  });
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function modelWindow(payload) {
  const id = String((payload && payload.model && payload.model.id) || '');
  const name = String((payload && payload.model && payload.model.display_name) || '');
  const s = (id + ' ' + name).toLowerCase();
  if (s.includes('[1m]') || /\b1m\b/.test(s) || s.includes('1-m') || s.includes('1000k')) {
    return EXTENDED_WINDOW;
  }
  return DEFAULT_WINDOW;
}

function lastUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const usage = obj && obj.message && obj.message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const input = Number(usage.input_tokens || 0);
    const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
    const cacheRead = Number(usage.cache_read_input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    const total = input + cacheCreation + cacheRead + output;
    if (!Number.isFinite(total) || total <= 0) continue;
    return { input, cacheCreation, cacheRead, output, total };
  }
  return null;
}

function renderBar(used, limit) {
  const fraction = Math.max(0, Math.min(1, used / limit));
  const ofUsable = Math.max(0, Math.min(1, fraction / AUTOCOMPACT_BUFFER));
  const pct = Math.round(ofUsable * 100);
  const filled = Math.round(ofUsable * BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  let color = '\x1b[32m';
  let suffix = '';
  if (pct >= 80) { color = '\x1b[31m'; suffix = ' 💀'; }
  else if (pct >= 65) { color = '\x1b[38;5;208m'; }
  else if (pct >= 50) { color = '\x1b[33m'; }
  return color + bar + '\x1b[0m ' + pct + '%' + suffix;
}

function terminalWidth() {
  const envCols = Number(process.env.COLUMNS);
  if (Number.isFinite(envCols) && envCols > 0) return envCols;
  if (process.stdout && process.stdout.columns) return process.stdout.columns;
  try {
    const { execSync } = require('node:child_process');
    const out = execSync('tput cols', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 120;
}

function visibleLen(s) {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) w += 2;
    else w += 1;
  }
  return w;
}

function centerLine(line) {
  const width = terminalWidth();
  const pad = Math.max(0, Math.floor((width - visibleLen(line)) / 2));
  return ' '.repeat(pad) + line;
}

function writeBridge(payload, usage, limit) {
  const sid = payload && payload.session_id;
  if (!sid) return;
  const bridgePath = path.join(os.tmpdir(), 'claude-ctx-' + String(sid).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
  const data = {
    session_id: sid,
    used: usage.total,
    limit: limit,
    usable_remaining_pct: Math.max(0, Math.round(((AUTOCOMPACT_BUFFER * limit) - usage.total) / (AUTOCOMPACT_BUFFER * limit) * 100)),
    updated_at: new Date().toISOString(),
  };
  try { fs.writeFileSync(bridgePath, JSON.stringify(data)); } catch {}
}

(async () => {
  let payload = {};
  try { payload = await readStdinJson(); } catch { payload = {}; }
  const limit = modelWindow(payload);
  const usage = lastUsage(payload && payload.transcript_path);
  const prefix = '\x1b[38;5;33mnubos-pilot\x1b[0m';
  if (!usage) {
    process.stdout.write(centerLine(prefix));
    return;
  }
  writeBridge(payload, usage, limit);
  const bar = renderBar(usage.total, limit);
  const modelName = (payload && payload.model && payload.model.display_name) || '';
  const tail = modelName ? '  \x1b[2m' + modelName + '\x1b[0m' : '';
  process.stdout.write(centerLine(prefix + '  ctx ' + bar + tail));
})().catch(() => {
  process.stdout.write('\x1b[38;5;33mnubos-pilot\x1b[0m');
});
