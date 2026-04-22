'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  NubosPilotError,
  projectStateDir,
  withFileLock,
  atomicWriteFileSync,
} = require('../../lib/core.cjs');

const LOCK_TIMEOUT_MS = 10000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function _parseArgs(args) {
  const rest = [];
  for (const a of args || []) {
    if (!a.startsWith('-')) rest.push(a);
  }
  return { iso: rest[0] || null };
}

function _validateIso(raw) {
  if (!raw) {
    throw new NubosPilotError('session-pointer-missing-iso',
      'ISO-8601 UTC timestamp required (e.g. 2026-04-22T12:34:56Z)', {});
  }
  if (!ISO_RE.test(raw)) {
    throw new NubosPilotError('session-pointer-invalid-iso',
      'timestamp must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)', { iso: raw });
  }
  return raw;
}

function _pointerPath(cwd) {
  return path.join(projectStateDir(cwd), 'reports', '.last-session');
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);
  const iso = _validateIso(parsed.iso);

  const pointer = _pointerPath(cwd);
  fs.mkdirSync(path.dirname(pointer), { recursive: true });

  withFileLock(pointer, () => atomicWriteFileSync(pointer, iso), { timeoutMs: LOCK_TIMEOUT_MS });

  stdout.write(JSON.stringify({ ok: true, pointer, iso }));
  return 0;
}

module.exports = { run, _parseArgs, _validateIso, _pointerPath };
