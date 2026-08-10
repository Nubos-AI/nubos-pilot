'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicCreateExclusiveSync } = require('./core.cjs');

const HEADLESS_ENV = 'NUBOS_PILOT_HEADLESS';
const DEPTH_ENV = 'NUBOS_PILOT_HOOK_DEPTH';
const MAX_DEPTH_ENV = 'NUBOS_PILOT_MAX_HOOK_DEPTH';
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

function isHeadless(env) {
  const e = env || process.env;
  return e[HEADLESS_ENV] === '1';
}

function currentDepth(env) {
  const e = env || process.env;
  const n = parseInt(e[DEPTH_ENV], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function maxDepth(env) {
  const e = env || process.env;
  const n = parseInt(e[MAX_DEPTH_ENV], 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_DEPTH;
}

function depthExceeded(env) {
  return currentDepth(env) >= maxDepth(env);
}

function childSpawnEnv(env) {
  const out = Object.create(null);
  out[HEADLESS_ENV] = '1';
  out[DEPTH_ENV] = String(currentDepth(env) + 1);
  return out;
}

function _isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    return true;
  }
}

function _lockPath(root, agent) {
  return path.join(root, '.nubos-pilot', 'run', 'headless-' + agent + '.lock');
}

function _reclaimStaleLock(lockPath) {
  const aside = lockPath + '.stale.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  try { fs.renameSync(lockPath, aside); }
  catch { return; }
  try { fs.unlinkSync(aside); } catch {}
}

function tryAcquireSpawnLock(root, agent, opts) {
  const o = opts || {};
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : DEFAULT_LOCK_STALE_MS;
  const lockPath = _lockPath(root, agent);
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch {}
  const payload = JSON.stringify({
    pid: process.pid,
    agent,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      atomicCreateExclusiveSync(lockPath, payload);
      let released = false;
      return {
        acquired: true,
        lockPath,
        release() {
          if (released) return;
          released = true;
          let meta = null;
          try { meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch {}
          if (meta && meta.pid !== process.pid) return;
          try { fs.unlinkSync(lockPath); } catch {}
        },
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        return { acquired: false, error: (err && err.code) || 'unknown' };
      }
      let meta = null;
      let stat = null;
      try { meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch {}
      try { stat = fs.statSync(lockPath); } catch {}
      const ageStale = !!stat && (Date.now() - stat.mtimeMs > staleMs);
      const pidDead = !!meta && _isPidAlive(meta.pid) === false;
      if (ageStale || pidDead) {
        _reclaimStaleLock(lockPath);
        continue;
      }
      return { acquired: false, holder: meta };
    }
  }
  return { acquired: false };
}

module.exports = {
  HEADLESS_ENV,
  DEPTH_ENV,
  MAX_DEPTH_ENV,
  DEFAULT_MAX_DEPTH,
  DEFAULT_LOCK_STALE_MS,
  isHeadless,
  currentDepth,
  maxDepth,
  depthExceeded,
  childSpawnEnv,
  tryAcquireSpawnLock,
  _isPidAlive,
  _lockPath,
};
