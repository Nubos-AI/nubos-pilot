'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  NubosPilotError,
  projectStateDir,
  withFileLock,
} = require('../../lib/core.cjs');
const { aggregateSession } = require('../../lib/metrics-aggregate.cjs');

const LOCK_TIMEOUT_MS = 10000;

function _parseArgs(args) {
  const out = { since: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since' || a === '-s') { out.since = args[++i] || null; continue; }
  }
  return out;
}

function _pointerPath(cwd) {
  return path.join(projectStateDir(cwd), 'reports', '.last-session');
}

async function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);

  const pointer = _pointerPath(cwd);
  fs.mkdirSync(path.dirname(pointer), { recursive: true });

  let summary;
  try {
    summary = await withFileLock(pointer, async () => {
      let since = parsed.since || '';
      if (!since && fs.existsSync(pointer)) {
        since = fs.readFileSync(pointer, 'utf-8').trim();
      }
      return aggregateSession(since || null, { cwd });
    }, { timeoutMs: LOCK_TIMEOUT_MS });
  } catch (err) {
    if (err && err.name === 'NubosPilotError') throw err;
    throw new NubosPilotError('session-aggregate-failed',
      'aggregate failed: ' + (err && err.message),
      { cause: err && err.message });
  }

  stdout.write(JSON.stringify(summary));
  return 0;
}

module.exports = { run, _parseArgs, _pointerPath, LOCK_TIMEOUT_MS };
