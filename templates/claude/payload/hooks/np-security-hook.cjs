#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ALLOWED_VERBS = new Set(['session-start', 'baseline', 'scan', 'review', 'commit']);

function resolveNpTools() {
  const candidates = [
    path.join(process.cwd(), '.nubos-pilot', 'bin', 'np-tools.cjs'),
    path.join(__dirname, '..', '..', '..', '.nubos-pilot', 'bin', 'np-tools.cjs'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf-8');
    const timer = setTimeout(() => { try { process.stdin.removeAllListeners(); } catch {} resolve(buf); }, 800);
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

(async () => {
  if (process.env.NUBOS_PILOT_HEADLESS === '1') { process.exit(0); return; }
  const verb = process.argv[2];
  if (!ALLOWED_VERBS.has(verb)) { process.exit(0); return; }
  const npTools = resolveNpTools();
  if (!npTools) { process.exit(0); return; }
  const input = await readStdin();
  try {
    const r = cp.spawnSync(process.execPath, [npTools, 'security', verb, '--stdin'], {
      input,
      encoding: 'utf-8',
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      cwd: process.cwd(),
    });
    if (r && typeof r.stdout === 'string' && r.stdout.length) process.stdout.write(r.stdout);
  } catch { /* never let a security hook break the session */ }
  process.exit(0);
})().catch(() => { process.exit(0); });
