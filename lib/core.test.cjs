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

test('SA1 safeAssign filters __proto__ / constructor / prototype keys', () => {
  const target = { x: 1 };
  // JSON.parse of '{"__proto__":{"polluted":true}}' assigns own __proto__
  const poisoned = JSON.parse('{"__proto__":{"polluted":true},"y":2}');
  core.safeAssign(target, poisoned);
  assert.equal(target.y, 2);
  assert.equal(({}).polluted, undefined, 'Object.prototype must NOT be polluted');
  assert.equal(target.polluted, undefined, 'target.polluted must NOT exist');
});

test('SA2 safeAssign accepts multiple sources + skips non-objects', () => {
  const t = core.safeAssign({}, { a: 1 }, null, undefined, { b: 2 }, 'string', { c: 3 });
  assert.deepEqual(t, { a: 1, b: 2, c: 3 });
});

test('A7 sweepStaleTmpFiles unlinks tmp files older than threshold, leaves young ones', () => {
  const dir = mkSandbox();
  try {
    const oldTmp = path.join(dir, 'foo.txt.12345.aabbccddeeff.tmp');
    const youngTmp = path.join(dir, 'bar.txt.67890.112233445566.tmp');
    fs.writeFileSync(oldTmp, '');
    fs.writeFileSync(youngTmp, '');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldTmp, past, past);
    const out = core.sweepStaleTmpFiles(dir, { olderThanMs: 60 * 60 * 1000 });
    assert.equal(out.swept.length, 1);
    assert.ok(out.swept[0].endsWith('foo.txt.12345.aabbccddeeff.tmp'));
    assert.equal(fs.existsSync(oldTmp), false);
    assert.equal(fs.existsSync(youngTmp), true);
  } finally { rmSandbox(dir); }
});

test('A8 sweepStaleTmpFiles ignores non-tmp files', () => {
  const dir = mkSandbox();
  try {
    fs.writeFileSync(path.join(dir, 'normal.txt'), 'preserved');
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, 'normal.txt'), past, past);
    const out = core.sweepStaleTmpFiles(dir, { olderThanMs: 1000 });
    assert.deepEqual(out.swept, []);
    assert.equal(fs.existsSync(path.join(dir, 'normal.txt')), true);
  } finally { rmSandbox(dir); }
});

test('A6 atomicWriteFileSync rethrows when rename fails — no silent non-atomic fallback', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'rethrow.txt');
    const origRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('simulated EXDEV'); e.code = 'EXDEV'; throw e; };
    try {
      assert.throws(
        () => core.atomicWriteFileSync(target, 'payload'),
        (err) => err && err.code === 'EXDEV',
      );
    } finally {
      fs.renameSync = origRename;
    }
    assert.equal(fs.existsSync(target), false, 'target file must NOT have been written by fallback');
    const tmps = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(tmps, [], 'tmp must be cleaned up before rethrow');
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

test('L7 stale REMOTE lock past 5-minute cross-host envelope → reclaim (R25 from fourth review)', () => {
  // R25 from fourth review: cross-host stale-staleMs is now max(staleMs, 5min)
  // to avoid NFS races stealing live locks. Test reflects the longer envelope.
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'l.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: DEAD_PID,
      hostname: '__remote_test_host__',
      acquiredAt: new Date(sixMinAgo).toISOString(),
    }));
    const past = new Date(sixMinAgo);
    fs.utimesSync(lockPath, past, past);
    let entered = false;
    core.withFileLock(target, () => { entered = true; }, { timeoutMs: 200, pollMs: 20, staleMs: 30000 });
    assert.equal(entered, true, 'remote stale lock past 5-min cross-host envelope must be reclaimed');
    assert.equal(fs.existsSync(lockPath), false, 'lock must be removed after fn returns');
  } finally {
    rmSandbox(dir);
  }
});

test('L7c stale REMOTE lock past staleMs but UNDER cross-host envelope → no reclaim', () => {
  // Lock is 1 minute old — past staleMs (30s) but under the 5-minute cross-host
  // envelope. Same-host would reclaim, cross-host does not.
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'l.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    const oneMinAgo = Date.now() - 60 * 1000;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: DEAD_PID,
      hostname: '__remote_test_host__',
      acquiredAt: new Date(oneMinAgo).toISOString(),
    }));
    fs.utimesSync(lockPath, new Date(oneMinAgo), new Date(oneMinAgo));
    try {
      assert.throws(
        () => core.withFileLock(target, () => {}, { timeoutMs: 200, pollMs: 20, staleMs: 30000 }),
        (err) => err && err.code === 'lock-timeout',
      );
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  } finally {
    rmSandbox(dir);
  }
});

test('L7b stale REMOTE lock with FRESH acquiredAt → no reclaim, lock-timeout', () => {
  // Recency check protects against premature stealing: when acquiredAt is
  // within staleMs the lock is presumed live even though we cannot probe the
  // remote PID.
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'l.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: DEAD_PID,
      hostname: '__remote_test_host__',
      acquiredAt: new Date(Date.now() - 1000).toISOString(),
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

test('LA1 withFileLockAsync runs async fn, returns resolved value, removes lockfile', async () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'la1.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    let sawLock = false;
    const ret = await core.withFileLockAsync(target, async () => {
      sawLock = fs.existsSync(lockPath);
      await new Promise((r) => setTimeout(r, 5));
      return 'value';
    });
    assert.equal(sawLock, true);
    assert.equal(ret, 'value');
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    rmSandbox(dir);
  }
});

test('LA2 two concurrent withFileLockAsync on same path serialize — no interleave', async () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'la2.txt');
    fs.writeFileSync(target, '');
    const events = [];
    function section(tag) {
      return core.withFileLockAsync(target, async () => {
        events.push(tag + '-start');
        await new Promise((r) => setTimeout(r, 30));
        events.push(tag + '-end');
      }, { timeoutMs: 2000, pollMs: 10 });
    }
    await Promise.all([section('first'), section('second')]);
    const winnerFirst = events.indexOf('first-start') < events.indexOf('second-start');
    assert.deepEqual(
      events,
      winnerFirst
        ? ['first-start', 'first-end', 'second-start', 'second-end']
        : ['second-start', 'second-end', 'first-start', 'first-end'],
    );
  } finally {
    rmSandbox(dir);
  }
});

test('LA3 withFileLockAsync releases the lock when fn rejects', async () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'la3.txt');
    fs.writeFileSync(target, '');
    const lockPath = target + '.lock';
    await assert.rejects(
      core.withFileLockAsync(target, async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(fs.existsSync(lockPath), false, 'lock must be released after a rejected fn');
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
    const origOpen = fs.openSync;
    const opens = [];
    fs.openSync = function (p, ...rest) {
      if (typeof p === 'string') opens.push(p);
      return origOpen.apply(this, [p, ...rest]);
    };
    try {
      core.withFileLocks([z, a], () => {});
    } finally {
      fs.openSync = origOpen;
    }
    const lockOpens = opens.filter((p) => p.endsWith('.lock'));
    assert.ok(lockOpens.length >= 2, 'expected ≥2 lock opens, got ' + JSON.stringify(lockOpens));
    assert.ok(lockOpens[0].endsWith('a.lock-target.lock'), 'first lock must be sorted-first: ' + lockOpens[0]);
    assert.ok(lockOpens[1].endsWith('z.lock-target.lock'), 'second lock must be sorted-second: ' + lockOpens[1]);
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

test('AJ-1 appendJsonl writes object as single JSON line terminated with \\n', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    core.appendJsonl(target, { a: 1, b: 'x' });
    const raw = fs.readFileSync(target, 'utf-8');
    assert.equal(raw, '{"a":1,"b":"x"}\n');
  } finally { rmSandbox(dir); }
});

test('AJ-2 appendJsonl accepts pre-encoded string', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    core.appendJsonl(target, '{"raw":true}');
    assert.equal(fs.readFileSync(target, 'utf-8'), '{"raw":true}\n');
  } finally { rmSandbox(dir); }
});

test('AJ-3 appendJsonl rejects pre-encoded string with embedded newline', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    assert.throws(
      () => core.appendJsonl(target, '{"a":1}\n{"b":2}'),
      (err) => err instanceof core.NubosPilotError && err.code === 'append-jsonl-embedded-newline',
    );
    assert.equal(fs.existsSync(target), false, 'no file must be written on rejection');
  } finally { rmSandbox(dir); }
});

test('AJ-3b appendJsonl rejects U+2028 / U+2029 line separators in pre-encoded string', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    assert.throws(
      () => core.appendJsonl(target, '{"a":"\u2028"}'),
      (err) => err instanceof core.NubosPilotError && err.code === 'append-jsonl-embedded-newline',
    );
    assert.throws(
      () => core.appendJsonl(target, '{"a":"\u2029"}'),
      (err) => err instanceof core.NubosPilotError && err.code === 'append-jsonl-embedded-newline',
    );
  } finally { rmSandbox(dir); }
});

test('AJ-4 appendJsonl rejects record larger than maxLineBytes', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    const big = { msg: 'x'.repeat(200) };
    let thrown;
    try { core.appendJsonl(target, big, { maxLineBytes: 100 }); }
    catch (err) { thrown = err; }
    assert.ok(thrown instanceof core.NubosPilotError);
    assert.equal(thrown.code, 'append-jsonl-line-too-large');
    assert.ok(thrown.details.bytes > 100);
    assert.equal(thrown.details.maxLineBytes, 100);
  } finally { rmSandbox(dir); }
});

test('AJ-5 appendJsonl accepts record exactly at maxLineBytes (boundary)', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    const line = '{"a":"x"}\n';
    core.appendJsonl(target, { a: 'x' }, { maxLineBytes: Buffer.byteLength(line, 'utf-8') });
    assert.equal(fs.readFileSync(target, 'utf-8'), line);
  } finally { rmSandbox(dir); }
});

test('AJ-6 appendJsonl wraps circular structure stringify failure as typed error', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    const obj = { name: 'cycle' };
    obj.self = obj;
    let thrown;
    try { core.appendJsonl(target, obj); }
    catch (err) { thrown = err; }
    assert.ok(thrown instanceof core.NubosPilotError);
    assert.equal(thrown.code, 'append-jsonl-stringify-failed');
    assert.ok(thrown.details.cause);
  } finally { rmSandbox(dir); }
});

test('AJ-7 appendJsonl rejects undefined/function records as append-jsonl-invalid', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    let thrown;
    try { core.appendJsonl(target, undefined); }
    catch (err) { thrown = err; }
    assert.ok(thrown instanceof core.NubosPilotError);
    assert.equal(thrown.code, 'append-jsonl-invalid');
    try { core.appendJsonl(target, () => 1); }
    catch (err) { thrown = err; }
    assert.equal(thrown.code, 'append-jsonl-invalid');
  } finally { rmSandbox(dir); }
});

test('AJ-8 appendJsonl creates missing parent directory recursively', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'deep', 'nested', 'log.jsonl');
    core.appendJsonl(target, { ok: true });
    assert.ok(fs.existsSync(target));
  } finally { rmSandbox(dir); }
});

test('AJ-9 appendJsonl rejects parent path that is a file (ENOTDIR), surfaces typed error', () => {
  const dir = mkSandbox();
  try {
    const blocker = path.join(dir, 'block');
    fs.writeFileSync(blocker, 'not a dir');
    const target = path.join(blocker, 'log.jsonl');
    let thrown;
    try { core.appendJsonl(target, { ok: true }); }
    catch (err) { thrown = err; }
    assert.ok(thrown instanceof core.NubosPilotError);
    assert.equal(thrown.code, 'append-jsonl-parent-unusable');
  } finally { rmSandbox(dir); }
});

test('AJ-10 appendJsonl with lock:false skips withFileLock — no .lock file produced', () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    core.appendJsonl(target, { x: 1 }, { lock: false });
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(target + '.lock'), false);
  } finally { rmSandbox(dir); }
});

test('SIG-1 installSignalCleanup is idempotent and uninstall removes its handlers', () => {
  const before = process.listenerCount('SIGINT');
  core.installSignalCleanup();
  core.installSignalCleanup();
  const installed = process.listenerCount('SIGINT');
  assert.equal(installed, before + 1, 'exactly one SIGINT handler should be installed by the lib');
  core._uninstallSignalCleanupForTests();
  assert.equal(process.listenerCount('SIGINT'), before, 'uninstall restores prior listener count');
});

test('SIG-2 lib does not install signal handlers as a side effect of withFileLock', () => {
  core._uninstallSignalCleanupForTests();
  const before = process.listenerCount('SIGINT');
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'sig.txt');
    fs.writeFileSync(target, '');
    core.withFileLock(target, () => {});
    assert.equal(process.listenerCount('SIGINT'), before, 'withFileLock must not register SIGINT handlers');
  } finally { rmSandbox(dir); }
});

test('AJ-11 appendJsonl serialises parallel writers — N appends produce exactly N parseable lines', async () => {
  const dir = mkSandbox();
  try {
    const target = path.join(dir, 'log.jsonl');
    const N = 50;
    const tasks = [];
    for (let i = 0; i < N; i++) {
      tasks.push(new Promise((resolve, reject) => {
        try {
          core.appendJsonl(target, { i, payload: 'x'.repeat(200) });
          resolve();
        } catch (err) { reject(err); }
      }));
    }
    await Promise.all(tasks);
    const lines = fs.readFileSync(target, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, N);
    const seen = new Set();
    for (const l of lines) {
      const parsed = JSON.parse(l);
      assert.equal(typeof parsed.i, 'number');
      seen.add(parsed.i);
    }
    assert.equal(seen.size, N);
  } finally { rmSandbox(dir); }
});
