'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('./headless-guard.cjs');

const _sandboxes = [];

function _mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-headless-guard-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(r);
  return r;
}

afterEach(() => {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('HG-1: isHeadless is true only when NUBOS_PILOT_HEADLESS=1', () => {
  assert.equal(guard.isHeadless({}), false);
  assert.equal(guard.isHeadless({ NUBOS_PILOT_HEADLESS: '0' }), false);
  assert.equal(guard.isHeadless({ NUBOS_PILOT_HEADLESS: 'yes' }), false);
  assert.equal(guard.isHeadless({ NUBOS_PILOT_HEADLESS: '1' }), true);
});

test('HG-2: currentDepth parses NUBOS_PILOT_HOOK_DEPTH, defaults to 0', () => {
  assert.equal(guard.currentDepth({}), 0);
  assert.equal(guard.currentDepth({ NUBOS_PILOT_HOOK_DEPTH: 'x' }), 0);
  assert.equal(guard.currentDepth({ NUBOS_PILOT_HOOK_DEPTH: '0' }), 0);
  assert.equal(guard.currentDepth({ NUBOS_PILOT_HOOK_DEPTH: '2' }), 2);
});

test('HG-3: depthExceeded honours default cap of 1 and the env override', () => {
  assert.equal(guard.depthExceeded({}), false);
  assert.equal(guard.depthExceeded({ NUBOS_PILOT_HOOK_DEPTH: '1' }), true);
  assert.equal(guard.depthExceeded({ NUBOS_PILOT_HOOK_DEPTH: '1', NUBOS_PILOT_MAX_HOOK_DEPTH: '2' }), false);
  assert.equal(guard.depthExceeded({ NUBOS_PILOT_HOOK_DEPTH: '2', NUBOS_PILOT_MAX_HOOK_DEPTH: '2' }), true);
});

test('HG-4: childSpawnEnv marks headless and increments depth', () => {
  assert.deepEqual({ ...guard.childSpawnEnv({}) }, { NUBOS_PILOT_HEADLESS: '1', NUBOS_PILOT_HOOK_DEPTH: '1' });
  assert.deepEqual(
    { ...guard.childSpawnEnv({ NUBOS_PILOT_HOOK_DEPTH: '1' }) },
    { NUBOS_PILOT_HEADLESS: '1', NUBOS_PILOT_HOOK_DEPTH: '2' },
  );
});

test('HG-5: tryAcquireSpawnLock acquires, then refuses a live concurrent holder', () => {
  const r = _mkRoot();
  const first = guard.tryAcquireSpawnLock(r, 'np-test-critic');
  assert.equal(first.acquired, true);
  assert.ok(fs.existsSync(first.lockPath));

  const second = guard.tryAcquireSpawnLock(r, 'np-test-critic');
  assert.equal(second.acquired, false, 'second concurrent acquire must be refused');
  assert.ok(second.holder && second.holder.pid === process.pid);

  first.release();
  assert.equal(fs.existsSync(first.lockPath), false, 'release removes the lock');

  const third = guard.tryAcquireSpawnLock(r, 'np-test-critic');
  assert.equal(third.acquired, true, 'lock is re-acquirable after release');
  third.release();
});

test('HG-6: different agents get independent locks', () => {
  const r = _mkRoot();
  const a = guard.tryAcquireSpawnLock(r, 'np-security-reviewer');
  const b = guard.tryAcquireSpawnLock(r, 'np-learnings-extractor');
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true, 'a second agent must not be blocked by the first');
  a.release();
  b.release();
});

test('HG-7: a stale lock (old mtime) is reclaimed', () => {
  const r = _mkRoot();
  const held = guard.tryAcquireSpawnLock(r, 'np-test-critic');
  assert.equal(held.acquired, true);
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(held.lockPath, past, past);

  const next = guard.tryAcquireSpawnLock(r, 'np-test-critic', { staleMs: 1000 });
  assert.equal(next.acquired, true, 'a lock older than staleMs must be reclaimed');
  next.release();
});

test('HG-8: a dead-pid lock is reclaimed even when fresh', () => {
  const r = _mkRoot();
  const lockPath = guard._lockPath(r, 'np-test-critic');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, hostname: os.hostname(), acquiredAt: new Date().toISOString() }), 'utf-8');
  assert.equal(guard._isPidAlive(2147483646), false);

  const next = guard.tryAcquireSpawnLock(r, 'np-test-critic');
  assert.equal(next.acquired, true, 'a lock owned by a dead pid must be reclaimed');
  next.release();
});

test('HG-9: stale reclaim leaves no .stale residue behind', () => {
  const r = _mkRoot();
  const held = guard.tryAcquireSpawnLock(r, 'np-test-critic');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(held.lockPath, past, past);
  const next = guard.tryAcquireSpawnLock(r, 'np-test-critic', { staleMs: 1000 });
  assert.equal(next.acquired, true);
  next.release();
  const runDir = path.join(r, '.nubos-pilot', 'run');
  const residue = fs.readdirSync(runDir).filter((n) => n.includes('.stale.'));
  assert.deepEqual(residue, [], 'rename-aside reclaim must clean up its temp file');
});
