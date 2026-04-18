const core = require('./core.cjs');

const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

let DEAD_PID_AVAILABLE = true;
const DEAD_PID = 99999999;

before(() => {
  try {
    process.kill(DEAD_PID, 0);
    DEAD_PID_AVAILABLE = false;
  } catch (err) {
    DEAD_PID_AVAILABLE = err.code === 'ESRCH';
  }
});

function mkSandbox() {
  const dir = path.join(os.tmpdir(), 'nubos-pilot-test-' + crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmSandbox(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('NubosPilotError sets code, message, details, name and is instanceof Error', () => {
  const e = new core.NubosPilotError('lock-timeout', 'msg', { extra: 1 });
  assert.equal(e.code, 'lock-timeout');
  assert.equal(e.message, 'msg');
  assert.deepEqual(e.details, { extra: 1 });
  assert.equal(e.name, 'NubosPilotError');
  assert.ok(e instanceof Error);
});

test('A1 atomicWriteFileSync writes content round-trip-identical', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'a.txt');
    const content = 'hello world ' + crypto.randomBytes(4).toString('hex');
    core.atomicWriteFileSync(target, content);
    const read = fs.readFileSync(target, 'utf-8');
    assert.equal(read, content);
  } finally {
    rmSandbox(dir);
  }
});

test('A2 atomicWriteFileSync leaves no *.tmp leftover after success', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'b.txt');
    core.atomicWriteFileSync(target, 'x');
    const entries = fs.readdirSync(dir);
    const tmps = entries.filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(tmps, []);
  } finally {
    rmSandbox(dir);
  }
});

test('A3 atomicWriteFileSync overwrites existing file', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'c.txt');
    fs.writeFileSync(target, 'old');
    core.atomicWriteFileSync(target, 'new');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'new');
  } finally {
    rmSandbox(dir);
  }
});

test('A4 tmp filename pattern is <target>.<pid>.<12-hex>.tmp (observed via writeFileSync spy)', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'd.txt');
    const origWrite = fs.writeFileSync;
    const seenPaths = [];
    fs.writeFileSync = function (p, ...rest) {
      seenPaths.push(String(p));
      return origWrite.apply(this, [p, ...rest]);
    };
    try {
      core.atomicWriteFileSync(target, 'payload');
    } finally {
      fs.writeFileSync = origWrite;
    }
    const tmpCandidates = seenPaths.filter((p) => p !== target && p.startsWith(target + '.') && p.endsWith('.tmp'));
    assert.ok(tmpCandidates.length >= 1, 'expected at least one tmp write call; saw: ' + JSON.stringify(seenPaths));
    const tmp = tmpCandidates[0];
    const suffix = tmp.slice(target.length + 1);
    const match = /^(\d+)\.([0-9a-f]{12})\.tmp$/.exec(suffix);
    assert.ok(match, 'tmp suffix must be <pid>.<12-hex>.tmp, got: ' + suffix);
    assert.equal(Number(match[1]), process.pid);
  } finally {
    rmSandbox(dir);
  }
});

test('A5 two parallel atomicWriteFileSync calls to same target: no collision, final content is one of the payloads', async () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'e.txt');
    const a = 'A'.repeat(256);
    const b = 'B'.repeat(256);
    await Promise.all([
      Promise.resolve().then(() => core.atomicWriteFileSync(target, a)),
      Promise.resolve().then(() => core.atomicWriteFileSync(target, b)),
    ]);
    const final = fs.readFileSync(target, 'utf-8');
    assert.ok(final === a || final === b, 'final must equal one payload verbatim, got length ' + final.length);
    const entries = fs.readdirSync(dir);
    const tmps = entries.filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(tmps, [], 'no tmp leftovers after parallel writes');
  } finally {
    rmSandbox(dir);
  }
});

test('L1 withFileLock creates lockfile during fn and removes it after', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'f.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    let sawLock = false;
    core.withFileLock(target, () => {
      sawLock = fs.existsSync(lockPath);
    });
    assert.equal(sawLock, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    rmSandbox(dir);
  }
});

test('L2 lockfile content is valid JSON {pid, hostname, acquiredAt ISO-8601}', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'g.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    let meta;
    core.withFileLock(target, () => {
      meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    });
    assert.equal(typeof meta.pid, 'number');
    assert.equal(typeof meta.hostname, 'string');
    assert.ok(/^\d{4}-/.test(meta.acquiredAt), 'acquiredAt must be ISO-8601, got ' + meta.acquiredAt);
  } finally {
    rmSandbox(dir);
  }
});

test('L3 re-entrant withFileLock on same path sequences (second waits for first)', async () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'h.txt');
    fs.writeFileSync(target, '');
    const events = [];
    const first = new Promise((resolve) => {
      setImmediate(() => {
        core.withFileLock(target, () => {
          events.push('first-start');
          const until = Date.now() + 80;
          while (Date.now() < until) {  }
          events.push('first-end');
        }, { timeoutMs: 2000, pollMs: 10 });
        resolve();
      });
    });
    const second = new Promise((resolve) => {
      setImmediate(() => {
        setTimeout(() => {
          core.withFileLock(target, () => {
            events.push('second-start');
            events.push('second-end');
          }, { timeoutMs: 2000, pollMs: 10 });
          resolve();
        }, 10);
      });
    });
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
  } finally {
    rmSandbox(dir);
  }
});

test('L4 lock-timeout throws NubosPilotError with code lock-timeout when held by live local pid', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'i.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    }), { flag: 'wx' });
    try {
      assert.throws(
        () => core.withFileLock(target, () => {}, { timeoutMs: 200, pollMs: 20 }),
        (err) => err instanceof core.NubosPilotError && err.code === 'lock-timeout',
      );
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  } finally {
    rmSandbox(dir);
  }
});

test('L5 stale lock + dead PID + same hostname → force-acquire', (t) => {
  if (!DEAD_PID_AVAILABLE) { t.skip('DEAD_PID unexpectedly alive on this host'); return; }
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'j.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: DEAD_PID,
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
    }));
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, past, past);
    let ran = false;
    core.withFileLock(target, () => { ran = true; }, { timeoutMs: 1000, pollMs: 20, staleMs: 30000 });
    assert.equal(ran, true);
  } finally {
    rmSandbox(dir);
  }
});

test('L6 stale lock + ALIVE PID + same hostname → never force; lock-timeout', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'k.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
    }));
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, past, past);
    try {
      assert.throws(
        () => core.withFileLock(target, () => {}, { timeoutMs: 200, pollMs: 20, staleMs: 30000 }),
        (err) => err instanceof core.NubosPilotError && err.code === 'lock-timeout',
      );
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  } finally {
    rmSandbox(dir);
  }
});

test('L7 stale lock + REMOTE hostname → never force; lock-timeout', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'l.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: DEAD_PID,
      hostname: '__remote_test_host__',
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
    }));
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, past, past);
    try {
      assert.throws(
        () => core.withFileLock(target, () => {}, { timeoutMs: 200, pollMs: 20, staleMs: 30000 }),
        (err) => err instanceof core.NubosPilotError && err.code === 'lock-timeout',
      );
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  } finally {
    rmSandbox(dir);
  }
});

test('L8 exit-handler registration: process.listenerCount("exit") >= 1 after first withFileLock', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'm.txt');
    fs.writeFileSync(target, '');
    core.withFileLock(target, () => {});
    assert.ok(process.listenerCount('exit') >= 1);
  } finally {
    rmSandbox(dir);
  }
});

test('M1 withFileLocks acquires in lexicographic sort order', () => {
  const dir = mkSandbox();
  try {
    const a = path.join(dir, 'a.lock-target');
    const z = path.join(dir, 'z.lock-target');
    fs.writeFileSync(a, '');
    fs.writeFileSync(z, '');
    const origWrite = fs.writeFileSync;
    const writes = [];
    fs.writeFileSync = function (p, ...rest) {
      writes.push(String(p));
      return origWrite.apply(this, [p, ...rest]);
    };
    try {
      core.withFileLocks([z, a], () => {});
    } finally {
      fs.writeFileSync = origWrite;
    }
    const lockWrites = writes.filter((p) => p.endsWith('.lock'));
    assert.ok(lockWrites.length >= 2, 'expected ≥2 lock writes, got ' + JSON.stringify(lockWrites));
    assert.ok(lockWrites[0].endsWith('a.lock-target.lock'), 'first lock must be sorted-first: ' + lockWrites[0]);
    assert.ok(lockWrites[1].endsWith('z.lock-target.lock'), 'second lock must be sorted-second: ' + lockWrites[1]);
  } finally {
    rmSandbox(dir);
  }
});

test('M2 withFileLocks releases in reverse order (lockfiles disappear in reverse)', () => {
  const dir = mkSandbox();
  try {
    const a = path.join(dir, 'a.lock-target');
    const z = path.join(dir, 'z.lock-target');
    fs.writeFileSync(a, '');
    fs.writeFileSync(z, '');
    const origUnlink = fs.unlinkSync;
    const unlinks = [];
    fs.unlinkSync = function (p, ...rest) {
      unlinks.push(String(p));
      return origUnlink.apply(this, [p, ...rest]);
    };
    try {
      core.withFileLocks([z, a], () => {});
    } finally {
      fs.unlinkSync = origUnlink;
    }
    const lockUnlinks = unlinks.filter((p) => p.endsWith('.lock'));
    assert.ok(lockUnlinks.length >= 2);
    assert.ok(lockUnlinks[0].endsWith('z.lock-target.lock'), 'first unlink must be reverse-sorted: ' + lockUnlinks[0]);
    assert.ok(lockUnlinks[1].endsWith('a.lock-target.lock'), 'second unlink must be reverse-sorted: ' + lockUnlinks[1]);
  } finally {
    rmSandbox(dir);
  }
});

test('P1 findProjectRoot returns dir whose child is .nubos-pilot/', () => {
  const dir = mkSandbox();
  try {
    fs.mkdirSync(path.join(dir, '.nubos-pilot'));
    const root = core.findProjectRoot(dir);
    assert.equal(fs.realpathSync(root), fs.realpathSync(dir));
  } finally {
    rmSandbox(dir);
  }
});

test('P2 findProjectRoot walks up from nested subdir', () => {
  const dir = mkSandbox();
  try {
    fs.mkdirSync(path.join(dir, '.nubos-pilot'));
    const nested = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    const root = core.findProjectRoot(nested);
    assert.equal(fs.realpathSync(root), fs.realpathSync(dir));
  } finally {
    rmSandbox(dir);
  }
});

test('P3 findProjectRoot throws NubosPilotError code=not-in-project when no ancestor', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => core.findProjectRoot(dir),
      (err) => err instanceof core.NubosPilotError && err.code === 'not-in-project',
    );
  } finally {
    rmSandbox(dir);
  }
});

test('P4 projectStateDir returns path.join(root, .nubos-pilot)', () => {
  const dir = mkSandbox();
  try {
    fs.mkdirSync(path.join(dir, '.nubos-pilot'));
    const stateDir = core.projectStateDir(dir);
    assert.equal(fs.realpathSync(stateDir), fs.realpathSync(path.join(dir, '.nubos-pilot')));
  } finally {
    rmSandbox(dir);
  }
});
