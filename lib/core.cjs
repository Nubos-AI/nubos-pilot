const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

class NubosPilotError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'NubosPilotError';
    this.code = code;
    this.details = details;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, NubosPilotError);
    }
  }
}

function atomicWriteFileSync(filePath, content, encoding = 'utf-8') {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, encoding);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(filePath, content, encoding);
  }
}

const _heldLocks = new Set();
let _exitHandlerRegistered = false;

function _ensureExitHandler() {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  process.on('exit', () => {
    for (const p of _heldLocks) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
}

function _isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    return true;
  }
}

function _sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {  }
  }
}

function withFileLock(filePath, fn, opts) {
  const { timeoutMs = 10000, pollMs = 50, staleMs = 30000 } = opts || {};
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
  const lockPath = `${filePath}.lock`;
  const selfHost = os.hostname();
  const startedAt = Date.now();
  let lastMeta = null;

  while (true) {
    try {
      const payload = JSON.stringify({
        pid: process.pid,
        hostname: selfHost,
        acquiredAt: new Date().toISOString(),
      });
      fs.writeFileSync(lockPath, payload, { flag: 'wx' });
      _ensureExitHandler();
      _heldLocks.add(lockPath);
      try {
        return fn();
      } finally {
        _heldLocks.delete(lockPath);
        try { fs.unlinkSync(lockPath); } catch {}
      }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw err;
      }
      let meta = null;
      let stat = null;
      try {
        meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      } catch {}
      try {
        stat = fs.statSync(lockPath);
      } catch {}
      if (meta) lastMeta = meta;
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        if (meta && meta.hostname && meta.hostname !== selfHost) {

        } else if (meta && !_isPidAlive(meta.pid)) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new NubosPilotError(
          'lock-timeout',
          `Could not acquire lock on ${filePath} within ${timeoutMs}ms`,
          { lockPath, holder: lastMeta },
        );
      }
      _sleepSync(pollMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new NubosPilotError(
          'lock-timeout',
          `Could not acquire lock on ${filePath} within ${timeoutMs}ms`,
          { lockPath, holder: lastMeta },
        );
      }
    }
  }
}

function withFileLocks(paths, fn, opts) {
  const sorted = [...paths].sort();
  function acquire(idx) {
    if (idx >= sorted.length) return fn();
    return withFileLock(sorted[idx], () => acquire(idx + 1), opts);
  }
  return acquire(0);
}

function findProjectRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.nubos-pilot');
    try {
      if (fs.statSync(candidate).isDirectory()) return dir;
    } catch {  }
    if (dir === root) {
      throw new NubosPilotError(
        'not-in-project',
        `No .nubos-pilot/ ancestor of ${cwd}`,
        { startedFrom: cwd },
      );
    }
    dir = path.dirname(dir);
  }
}

function projectStateDir(cwd = process.cwd()) {
  return path.join(findProjectRoot(cwd), '.nubos-pilot');
}

module.exports = {
  atomicWriteFileSync,
  withFileLock,
  withFileLocks,
  findProjectRoot,
  projectStateDir,
  NubosPilotError,
};
