const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot, NubosPilotError } = require('../../lib/core.cjs');

const SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const BLOCKED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function _usage() {
  return 'Usage:\n  np-tools.cjs config-get <dotted.key> [--raw]';
}

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'config-get-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function _readConfig(cwd) {
  let root;
  try {
    root = findProjectRoot(cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') return null;
    throw err;
  }
  const p = path.join(root, '.nubos-pilot', 'config.json');
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    throw new NubosPilotError('config-parse-error', 'config.json invalid JSON', { cause: err && err.message });
  }
}

function _walkPath(obj, segments) {
  let cursor = obj;
  for (const seg of segments) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, seg)) return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}

function _validateSegments(segments) {
  for (const seg of segments) {
    if (BLOCKED_SEGMENTS.has(seg)) {
      throw new NubosPilotError('config-forbidden-key', 'config key segment forbidden: ' + seg, { segment: seg });
    }
    if (!SEGMENT_RE.test(seg)) {
      throw new NubosPilotError('config-invalid-key', 'config key segment must match /^[a-zA-Z0-9_-]+$/: ' + seg, { segment: seg });
    }
  }
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length === 0) {
    stderr.write(_usage() + '\n');
    return 1;
  }
  const raw = args.includes('--raw');
  const key = args.find((a) => !String(a).startsWith('--'));
  if (!key) {
    stderr.write(_usage() + '\n');
    return 1;
  }
  const segments = String(key).split('.');
  try {
    _validateSegments(segments);
    const config = _readConfig(cwd);
    if (config == null) {
      if (!raw) stdout.write('\n');
      return 0;
    }
    const value = _walkPath(config, segments);
    if (value === undefined) {
      if (!raw) stdout.write('\n');
      return 0;
    }
    const out = typeof value === 'string' ? value : JSON.stringify(value);
    if (raw) stdout.write(out);
    else stdout.write(out + '\n');
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, _walkPath, _validateSegments };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
