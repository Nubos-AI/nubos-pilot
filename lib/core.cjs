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

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* best-effort durability hint, see comment */ }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function atomicWriteFileSync(filePath, content, encoding = 'utf-8', mode = 0o644) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding, mode });
    fs.renameSync(tmp, filePath);
    fsyncDir(path.dirname(filePath));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function atomicCreateExclusiveSync(filePath, content, encoding = 'utf-8') {
  const NOFOLLOW = fs.constants && fs.constants.O_NOFOLLOW;
  if (NOFOLLOW) {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(filePath, flags, 0o644);
      fs.writeFileSync(fd, content, encoding);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  } else {
    try {
      const st = fs.lstatSync(filePath);
      if (st.isSymbolicLink()) {
        const e = new Error('ELOOP: refusing to follow symlink at target');
        e.code = 'ELOOP';
        e.path = filePath;
        throw e;
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    fs.writeFileSync(filePath, content, { flag: 'wx', encoding });
  }
  fsyncDir(path.dirname(filePath));
}

const _TMP_RE = /^(.+?)\.(\d+)\.([0-9a-f]{12})\.tmp$/;
const _LEGACY_TMP_RE = /^.+\.(?:bak\.)?tmp$/;

function sweepStaleTmpFiles(dir, opts) {
  const o = opts || {};
  const olderThanMs = Number.isFinite(o.olderThanMs) ? o.olderThanMs : 60 * 60 * 1000;
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (err) { if (err && err.code === 'ENOENT') return { swept: [], skipped: [] }; throw err; }
  const now = Date.now();
  const swept = [];
  const skipped = [];
  for (const name of entries) {
    if (!_TMP_RE.test(name) && !_LEGACY_TMP_RE.test(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (now - st.mtimeMs < olderThanMs) { skipped.push(abs); continue; }
    try { fs.unlinkSync(abs); swept.push(abs); }
    catch { /* ignore — peer may have just won the unlink race */ }
  }
  return { swept, skipped };
}

const _heldLocks = new Set();
let _exitHandlerRegistered = false;

function _releaseHeldLocks() {
  for (const p of _heldLocks) {
    try { fs.unlinkSync(p); } catch {}
  }
  _heldLocks.clear();
}

function _ensureExitHandler() {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  process.on('exit', _releaseHeldLocks);
}

const _SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const _SIGNO = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let _signalCleanupInstalled = false;
const _signalHandlers = new Map();

function installSignalCleanup() {
  if (_signalCleanupInstalled) return;
  _signalCleanupInstalled = true;
  _ensureExitHandler();
  for (const sig of _SIGNALS) {
    const handler = () => {
      _releaseHeldLocks();
      process.removeListener(sig, handler);
      _signalHandlers.delete(sig);
      try { process.kill(process.pid, sig); }
      catch { process.exit(_SIGNO[sig] || 1); }
    };
    _signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }
}

function _uninstallSignalCleanupForTests() {
  for (const [sig, handler] of _signalHandlers) {
    try { process.removeListener(sig, handler); } catch {}
  }
  _signalHandlers.clear();
  _signalCleanupInstalled = false;
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

function _createLockExclusive(lockPath, payload) {
  const NOFOLLOW = fs.constants && fs.constants.O_NOFOLLOW;
  if (NOFOLLOW) {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(lockPath, flags, 0o600);
      fs.writeFileSync(fd, payload, 'utf-8');
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    return;
  }
  try {
    const st = fs.lstatSync(lockPath);
    if (st.isSymbolicLink()) {
      const e = new Error('ELOOP: refusing to write through symlink lock');
      e.code = 'ELOOP';
      e.path = lockPath;
      throw e;
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(lockPath, payload, { flag: 'wx', mode: 0o600, encoding: 'utf-8' });
}

function _safeUnlinkLock(lockPath) {
  try {
    const st = fs.lstatSync(lockPath);
    if (st.isSymbolicLink()) return false;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    return false;
  }
  try { fs.unlinkSync(lockPath); return true; }
  catch { return false; }
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
      _ensureExitHandler();
      _createLockExclusive(lockPath, payload);
      _heldLocks.add(lockPath);
      try {
        return fn();
      } finally {
        _heldLocks.delete(lockPath);
        _safeUnlinkLock(lockPath);
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
      const CROSS_HOST_STALE_MS = Math.max(staleMs, 5 * 60 * 1000);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        if (meta && meta.hostname && meta.hostname !== selfHost) {
          const acquiredAt = meta.acquiredAt ? Date.parse(meta.acquiredAt) : null;
          const mtimeAgeOk = Date.now() - stat.mtimeMs > CROSS_HOST_STALE_MS;
          const acquiredAgeOk = acquiredAt == null || Date.now() - acquiredAt > CROSS_HOST_STALE_MS;
          if (mtimeAgeOk && acquiredAgeOk) {
            _safeUnlinkLock(lockPath);
            try {
              const _core_log = require('./logger.cjs').child('core.lock');
              _core_log.warn('cross-host lock reclaim', {
                event: 'lock-cross-host-reclaim',
                file: path.basename(lockPath),
                host: meta.hostname,
                pid: meta.pid,
                acquired_at: meta.acquiredAt || null,
              });
            } catch { /* best-effort */ }
            continue;
          }
        } else if (meta && !_isPidAlive(meta.pid)) {
          _safeUnlinkLock(lockPath);
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

async function withFileLockAsync(filePath, fn, opts) {
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
      _ensureExitHandler();
      _createLockExclusive(lockPath, payload);
      _heldLocks.add(lockPath);
      try {
        return await fn();
      } finally {
        _heldLocks.delete(lockPath);
        _safeUnlinkLock(lockPath);
      }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw err;
      }
      let meta = null;
      let stat = null;
      try { meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch {}
      try { stat = fs.statSync(lockPath); } catch {}
      if (meta) lastMeta = meta;
      const CROSS_HOST_STALE_MS = Math.max(staleMs, 5 * 60 * 1000);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        if (meta && meta.hostname && meta.hostname !== selfHost) {
          const acquiredAt = meta.acquiredAt ? Date.parse(meta.acquiredAt) : null;
          const mtimeAgeOk = Date.now() - stat.mtimeMs > CROSS_HOST_STALE_MS;
          const acquiredAgeOk = acquiredAt == null || Date.now() - acquiredAt > CROSS_HOST_STALE_MS;
          if (mtimeAgeOk && acquiredAgeOk) {
            _safeUnlinkLock(lockPath);
            try {
              require('./logger.cjs').child('core.lock').warn('cross-host lock reclaim (async)', {
                event: 'lock-cross-host-reclaim-async',
                file: path.basename(lockPath),
                host: meta.hostname,
                pid: meta.pid,
                acquired_at: meta.acquiredAt || null,
              });
            } catch { /* best-effort */ }
            continue;
          }
        } else if (meta && !_isPidAlive(meta.pid)) {
          _safeUnlinkLock(lockPath);
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
      await new Promise((resolve) => setTimeout(resolve, pollMs));
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

const _PROTO_POLLUTION_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

function safeAssign(target, ...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const key of Object.keys(src)) {
      if (_PROTO_POLLUTION_KEYS.includes(key)) continue;
      target[key] = src[key];
    }
  }
  return target;
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const _RECORD_NEWLINE_RE = /[\r\n\u2028\u2029]/;

function appendJsonl(filePath, record, opts) {
  const o = opts || {};
  let obj;
  if (typeof record === 'string') {
    obj = record;
  } else {
    try { obj = JSON.stringify(record); }
    catch (err) {
      throw new NubosPilotError(
        'append-jsonl-stringify-failed',
        'JSON.stringify threw while encoding record',
        { file: path.basename(filePath), cause: err && err.code ? err.code : (err && err.name) || 'unknown' },
      );
    }
  }
  if (typeof obj !== 'string') {
    throw new NubosPilotError(
      'append-jsonl-invalid',
      'record must be a non-null object or pre-encoded JSON string',
      { type: typeof record },
    );
  }
  if (_RECORD_NEWLINE_RE.test(obj)) {
    throw new NubosPilotError(
      'append-jsonl-embedded-newline',
      'JSONL record must not contain a literal newline or line separator',
      { file: path.basename(filePath) },
    );
  }
  const line = obj + '\n';
  if (Number.isFinite(o.maxLineBytes)) {
    const bytes = Buffer.byteLength(line, 'utf-8');
    if (bytes > o.maxLineBytes) {
      throw new NubosPilotError(
        'append-jsonl-line-too-large',
        `JSONL record (${bytes} bytes) exceeds maxLineBytes (${o.maxLineBytes})`,
        { file: path.basename(filePath), bytes, maxLineBytes: o.maxLineBytes },
      );
    }
  }
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
  catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw new NubosPilotError(
        'append-jsonl-parent-unusable',
        'cannot create parent directory for JSONL append',
        { file: path.basename(filePath), cause: err && err.code ? err.code : 'unknown' },
      );
    }
  }
  const mode = Number.isInteger(o.mode) ? o.mode : 0o644;
  const write = () => fs.appendFileSync(filePath, line, { encoding: 'utf-8', mode });
  try {
    if (o.lock === false) write();
    else withFileLock(filePath, write, o.lockOpts);
  } catch (err) {
    if (err && err instanceof NubosPilotError) throw err;
    if (err && (err.code === 'ENOTDIR' || err.code === 'EISDIR' || err.code === 'EACCES' || err.code === 'EPERM')) {
      throw new NubosPilotError(
        'append-jsonl-parent-unusable',
        'cannot append to JSONL stream',
        { file: path.basename(filePath), cause: err.code },
      );
    }
    throw err;
  }
  return filePath;
}

module.exports = {
  atomicWriteFileSync,
  atomicCreateExclusiveSync,
  fsyncDir,
  sweepStaleTmpFiles,
  withFileLock,
  withFileLocks,
  withFileLockAsync,
  findProjectRoot,
  projectStateDir,
  safeAssign,
  normalizeText,
  appendJsonl,
  installSignalCleanup,
  _uninstallSignalCleanupForTests,
  NubosPilotError,
};
