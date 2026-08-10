'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');

const FRONTMATTER_ORDER = ['slug', 'status', 'created', 'last_resumed'];

function _parseArgs(args) {
  const out = { path: null, today: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { rest.push(a); continue; }
    if (a === '--today' || a === '-t') { out.today = args[++i] || null; continue; }
  }
  if (rest.length) out.path = rest[0];
  return out;
}

function _bumpStatus(cur) {
  const s = String(cur || 'OPEN');
  if (s === 'OPEN') return 'IN_PROGRESS';
  return s;
}

function _serialize(fm, body) {
  const lines = ['---'];
  const seen = new Set();
  for (const k of FRONTMATTER_ORDER) {
    if (k in fm) { lines.push(k + ': ' + fm[k]); seen.add(k); }
  }
  for (const k of Object.keys(fm)) {
    if (!seen.has(k)) lines.push(k + ': ' + fm[k]);
  }
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);

  if (!parsed.path) {
    throw new NubosPilotError('thread-resume-missing-path',
      'thread path required', {});
  }
  const today = parsed.today || new Date().toISOString().slice(0, 10);

  const resolved = path.resolve(cwd, parsed.path);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    throw new NubosPilotError('thread-resume-read-error',
      'cannot read thread file: ' + (err && err.message),
      { path: resolved, cause: err && err.code });
  }

  let parts;
  try {
    parts = extractFrontmatter(raw);
  } catch (err) {
    throw new NubosPilotError('thread-resume-parse-error',
      'thread frontmatter invalid: ' + (err && err.message),
      { path: resolved, cause: err && err.code });
  }

  const fm = Object.assign({}, parts.frontmatter);
  fm.status = _bumpStatus(fm.status);
  fm.last_resumed = today;

  const out = _serialize(fm, parts.body);
  atomicWriteFileSync(resolved, out);

  stdout.write(JSON.stringify({ ok: true, path: resolved, status: fm.status, last_resumed: fm.last_resumed }));
  return 0;
}

module.exports = { run, _parseArgs, _bumpStatus, _serialize, FRONTMATTER_ORDER };
