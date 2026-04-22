'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const roadmap = require('../../lib/roadmap.cjs');

function _parseArgs(args) {
  const out = { milestone: null, json: null, stdin: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      if (out.milestone == null) { out.milestone = a; continue; }
      continue;
    }
    if (a === '--json' || a === '-j') { out.json = args[++i] || null; continue; }
    if (a === '--stdin') { out.stdin = true; continue; }
  }
  return out;
}

function _readStdinSync() {
  const fs = require('node:fs');
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function _validateMilestone(raw) {
  if (raw == null) {
    throw new NubosPilotError('update-phase-meta-missing-milestone',
      'milestone number required (e.g. M002 or 2)', {});
  }
  const s = String(raw).trim();
  const m = s.match(/^M?(\d+(?:\.\d+)?)$/i);
  if (!m) {
    throw new NubosPilotError('update-phase-meta-invalid-milestone',
      'milestone must be M<NNN> or <number>', { milestone: raw });
  }
  return m[1];
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const readStdin = typeof o.readStdin === 'function' ? o.readStdin : _readStdinSync;
  const stdinIsTty = o.stdinIsTty != null ? !!o.stdinIsTty : !!process.stdin.isTTY;
  const parsed = _parseArgs(args || []);
  const mNum = _validateMilestone(parsed.milestone);

  let rawJson = parsed.json;
  if (!rawJson && parsed.stdin) rawJson = readStdin();
  if (!rawJson && !stdinIsTty) rawJson = readStdin();
  if (!rawJson) {
    throw new NubosPilotError('update-phase-meta-missing-json',
      'JSON patch required (via --json, --stdin, or piped stdin)', {});
  }

  let patch;
  try {
    patch = JSON.parse(rawJson);
  } catch (err) {
    throw new NubosPilotError('update-phase-meta-invalid-json',
      'invalid JSON patch: ' + err.message, { cause: err.message });
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new NubosPilotError('update-phase-meta-invalid-json',
      'JSON patch must be an object', {});
  }

  const result = roadmap.updatePhase(mNum, patch, cwd);
  stdout.write(JSON.stringify({ ok: true, milestone: mNum, result }, null, 2) + '\n');
  return 0;
}

module.exports = { run, _parseArgs, _validateMilestone };
