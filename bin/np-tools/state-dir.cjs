'use strict';

const path = require('node:path');
const { projectStateDir, NubosPilotError } = require('../../lib/core.cjs');

const SUBDIR_RE = /^[a-zA-Z0-9._-][a-zA-Z0-9._/-]*$/;

function _parseArgs(args) {
  const out = { subdir: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--subdir' || a === '-s') { out.subdir = args[++i] || null; continue; }
  }
  return out;
}

function _validateSubdir(raw) {
  if (raw == null) return null;
  const s = String(raw);
  if (s.includes('..')) {
    throw new NubosPilotError('state-dir-invalid-subdir',
      'subdir must not contain ".."', { subdir: raw });
  }
  if (path.isAbsolute(s)) {
    throw new NubosPilotError('state-dir-invalid-subdir',
      'subdir must be relative', { subdir: raw });
  }
  if (!SUBDIR_RE.test(s)) {
    throw new NubosPilotError('state-dir-invalid-subdir',
      'subdir contains forbidden characters', { subdir: raw });
  }
  return s;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);
  const subdir = _validateSubdir(parsed.subdir);
  const base = projectStateDir(cwd);
  const out = subdir == null ? base : path.join(base, subdir);
  stdout.write(out);
  return 0;
}

module.exports = { run, _parseArgs, _validateSubdir };
