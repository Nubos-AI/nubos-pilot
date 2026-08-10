'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { mutateState } = require('../../lib/state.cjs');

const ALLOWED_KEYS = new Set(['pending_todos']);

function _parseArgs(args) {
  const rest = [];
  for (const a of args || []) {
    if (!a.startsWith('-')) rest.push(a);
  }
  return { key: rest[0] || null };
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);

  if (!parsed.key) {
    throw new NubosPilotError('state-incr-missing-key',
      'state counter key required', { allowed: Array.from(ALLOWED_KEYS) });
  }
  if (!ALLOWED_KEYS.has(parsed.key)) {
    throw new NubosPilotError('state-incr-unknown-key',
      'state counter key not in whitelist: ' + parsed.key,
      { key: parsed.key, allowed: Array.from(ALLOWED_KEYS) });
  }

  const next = mutateState((doc) => {
    const current = doc.frontmatter[parsed.key];
    const asNumber = typeof current === 'number' && Number.isFinite(current) ? current : 0;
    doc.frontmatter[parsed.key] = asNumber + 1;
    return doc;
  }, cwd);

  stdout.write(JSON.stringify({ ok: true, key: parsed.key, value: next.frontmatter[parsed.key] }));
  return 0;
}

module.exports = { run, _parseArgs, ALLOWED_KEYS };
